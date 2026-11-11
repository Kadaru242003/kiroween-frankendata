/**
 * Safe DuckDB result-value conversion for "Ask the Lab" (Feature 3, task 3).
 *
 * DuckDB-WASM returns a query's cell values in several JS shapes that do NOT
 * render or serialize cleanly: `bigint` for BIGINT/HUGEINT, epoch-ms numbers or
 * `Date` objects for DATE/TIMESTAMP, a scaled DECIMAL representation, and
 * arrays/structs for LIST/STRUCT columns. Passed straight to the table, chart,
 * or CSV these would throw (`JSON.stringify` on a bigint) or render
 * `[object Object]`.
 *
 * {@link toDisplayValue} converts ANY value to a {@link DisplayValue}
 * (string | number | boolean) so the table, chart, and CSV all consume one
 * stable representation and none ever throws or shows `[object Object]`
 * (Req 7.1–7.4). It is a pure function — no DuckDB, no network.
 *
 * Conversion order (design: "Result value conversion"):
 *   1. null / undefined        → ""
 *   2. bigint                  → number if safe, else decimal string
 *   3. Date                    → ISO string
 *   4. DECIMAL (scaled/Arrow)  → finite number
 *   5. number / boolean / string → as-is
 *   6. other typed arrays / objects → JSON string (never [object Object])
 *
 * The caller tells {@link toDisplayRow} which columns are TIMESTAMP-like so a
 * bare epoch-ms number in such a column is converted to an ISO string (a plain
 * numeric column's numbers are left as numbers).
 */

import type { DisplayValue } from "./types.js";

/**
 * Convert an epoch-ms number/bigint, a `Date`, or an ISO-ish string to a
 * timezone-safe `YYYY-MM-DD` date-only string, or `null` when it is not a
 * finite instant. Uses UTC components so a UTC-midnight instant keeps its
 * calendar day regardless of host timezone (mirrors the data layer's
 * `duckDbDateToIso`, inlined here to keep this pure core module free of a
 * dependency on `src/db`).
 */
function epochToIsoDate(value: unknown): string | null {
  let ms: number | null = null;
  if (typeof value === "number") ms = value;
  else if (typeof value === "bigint") ms = Number(value);
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "string") {
    // Already ISO-ish? Keep just the date portion.
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (m) return m[1];
    const parsed = Date.parse(value);
    ms = Number.isNaN(parsed) ? null : parsed;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** A column whose raw DuckDB values are epoch-ms timestamps to render as ISO. */
export type TimestampColumns = ReadonlySet<string>;
/** A column whose raw DuckDB values are DATEs to render as `YYYY-MM-DD`. */
export type DateColumns = ReadonlySet<string>;

/**
 * How a column's temporal values should be rendered:
 *   - `"timestamp"` → full ISO string (TIMESTAMP / TIMESTAMPTZ columns);
 *   - `"date"`      → `YYYY-MM-DD` date-only string (DATE columns);
 *   - `undefined`   → not temporal; numbers stay numbers.
 *
 * DuckDB's browser bundles surface DATE/TIMESTAMP as epoch-ms numbers (or Date
 * objects), so a column-type-aware caller passes the kind to render them
 * correctly instead of leaking raw epoch milliseconds.
 */
export type TemporalKind = "timestamp" | "date";

/**
 * Convert a single DuckDB result value to a safe {@link DisplayValue}.
 *
 * @param value The raw value from a `DuckDBService.query` row.
 * @param temporal The column's temporal kind (see {@link TemporalKind}). When
 *   omitted (or `false`), a finite `number` stays a number; a `"timestamp"`
 *   epoch-ms number renders as full ISO, a `"date"` one as `YYYY-MM-DD`.
 *   A boolean is accepted for backward compatibility (`true` ≡ `"timestamp"`).
 */
export function toDisplayValue(
  value: unknown,
  temporal: TemporalKind | boolean = false
): DisplayValue {
  const kind: TemporalKind | undefined =
    temporal === true ? "timestamp" : temporal === false ? undefined : temporal;

  // 1. Missing.
  if (value === null || value === undefined) return "";

  // 2. BigInt (BIGINT / HUGEINT).
  if (typeof value === "bigint") {
    if (kind === "date" || kind === "timestamp") {
      // A temporal column may surface its value as bigint epoch-ms.
      const iso = temporalIso(value, kind);
      if (iso !== null) return iso;
    }
    if (
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return Number(value);
    }
    return value.toString();
  }

  // 3. Date object (TIMESTAMP / DATE).
  if (value instanceof Date) {
    if (kind === "date") return epochToIsoDate(value) ?? "";
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }

  // 4b. A numeric DATE/TIMESTAMP (epoch ms) when the column is declared temporal.
  if (typeof value === "number") {
    if (kind && Number.isFinite(value)) {
      const iso = temporalIso(value, kind);
      if (iso !== null) return iso;
    }
    return value;
  }

  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;

  // 4. DECIMAL — DuckDB-WASM returns a scaled representation, not a JS number.
  const decimal = tryDecimalToNumber(value);
  if (decimal !== null) return decimal;

  // 6. Any other typed array / object (LIST, STRUCT, MAP, Arrow vector, …).
  //    Serialize to a stable string; never [object Object], never throws.
  return safeStringify(value);
}

/**
 * Render an epoch-ms (number/bigint) temporal value to its ISO form: a full ISO
 * string for `"timestamp"`, or a `YYYY-MM-DD` date-only string for `"date"`
 * (reusing the timezone-safe {@link duckDbDateToIso} for the date case).
 * Returns `null` when the value is not a finite instant.
 */
function temporalIso(value: number | bigint, kind: TemporalKind): string | null {
  if (kind === "date") return epochToIsoDate(value);
  const ms = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Resolve a column's temporal kind from the date/timestamp column sets. */
function kindFor(
  column: string,
  dateColumns: DateColumns,
  timestampColumns: TimestampColumns
): TemporalKind | undefined {
  if (dateColumns.has(column)) return "date";
  if (timestampColumns.has(column)) return "timestamp";
  return undefined;
}

/**
 * Convert a whole result row, honoring the DATE and TIMESTAMP column sets. DATE
 * columns render as `YYYY-MM-DD`; TIMESTAMP columns as full ISO strings; all
 * other columns by the default rules.
 */
export function toDisplayRow(
  row: Record<string, unknown>,
  columns: string[],
  timestampColumns: TimestampColumns = new Set(),
  dateColumns: DateColumns = new Set()
): DisplayValue[] {
  return columns.map((c) =>
    toDisplayValue(row[c], kindFor(c, dateColumns, timestampColumns))
  );
}

/** Convert an array of result rows into a display matrix in column order. */
export function toDisplayRows(
  rows: Record<string, unknown>[],
  columns: string[],
  timestampColumns: TimestampColumns = new Set(),
  dateColumns: DateColumns = new Set()
): DisplayValue[][] {
  return rows.map((r) =>
    toDisplayRow(r, columns, timestampColumns, dateColumns)
  );
}

/**
 * Try to interpret `value` as a DuckDB DECIMAL and return a finite number, or
 * `null` when it is not a decimal shape.
 *
 * DuckDB-WASM / Arrow surface DECIMALs in a few ways depending on the build:
 *   - a `{ value: bigint | number; scale: number }`-ish object;
 *   - a typed-array / byte representation carrying a `scale`;
 *   - occasionally already a number (older bindings) — handled upstream.
 * We read an integer "unscaled" value and divide by 10^scale. As a last resort
 * we parse the value's string form (e.g. "12.34"), which covers builds that
 * return a decimal as a plain stringifiable object.
 */
function tryDecimalToNumber(value: object): number | null {
  const v = value as {
    scale?: unknown;
    value?: unknown;
    unscaled?: unknown;
  };

  const scale =
    typeof v.scale === "number" && Number.isFinite(v.scale) ? v.scale : null;

  if (scale !== null) {
    const unscaledRaw = v.unscaled ?? v.value;
    let unscaled: number | null = null;
    if (typeof unscaledRaw === "bigint") unscaled = Number(unscaledRaw);
    else if (typeof unscaledRaw === "number" && Number.isFinite(unscaledRaw)) {
      unscaled = unscaledRaw;
    } else if (typeof unscaledRaw === "string" && unscaledRaw.trim() !== "") {
      const n = Number(unscaledRaw);
      if (Number.isFinite(n)) unscaled = n;
    }
    if (unscaled !== null) {
      const result = unscaled / Math.pow(10, scale);
      if (Number.isFinite(result)) return result;
    }
  }

  // Fallback: the object's string form looks like a plain decimal number.
  const asString = tryToString(value);
  if (asString !== null && /^[-+]?\d+(\.\d+)?$/.test(asString.trim())) {
    const n = Number(asString);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

/** `String(value)` guarded against throwing/`[object Object]`. */
function tryToString(value: unknown): string | null {
  try {
    const s = String(value);
    if (s === "[object Object]") return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Stringify a non-primitive value safely. Prefers JSON (handling bigint inside
 * nested structures), falls back to a non-`[object Object]` `String(...)`, and
 * finally to an empty string — it never throws.
 */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    if (json !== undefined && json !== "{}" && json !== '"[object Object]"') {
      return json;
    }
  } catch {
    /* fall through */
  }
  const s = tryToString(value);
  return s ?? "";
}
