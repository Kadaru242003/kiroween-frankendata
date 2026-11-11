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

/** A column whose raw DuckDB values are epoch-ms timestamps to render as ISO. */
export type TimestampColumns = ReadonlySet<string>;

/**
 * Convert a single DuckDB result value to a safe {@link DisplayValue}.
 *
 * @param value The raw value from a `DuckDBService.query` row.
 * @param isEpochMsTimestamp When true, a finite `number` value is treated as
 *   epoch milliseconds and rendered as an ISO string (used for TIMESTAMP
 *   columns, whose browser values arrive as epoch-ms numbers). Defaults to
 *   false, so ordinary numeric columns keep their numbers.
 */
export function toDisplayValue(
  value: unknown,
  isEpochMsTimestamp = false
): DisplayValue {
  // 1. Missing.
  if (value === null || value === undefined) return "";

  // 2. BigInt (BIGINT / HUGEINT).
  if (typeof value === "bigint") {
    if (
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return Number(value);
    }
    return value.toString();
  }

  // 3. Date (TIMESTAMP / DATE objects).
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }

  // 4b. A numeric TIMESTAMP (epoch ms) when the column is declared timestamp.
  if (typeof value === "number") {
    if (isEpochMsTimestamp && Number.isFinite(value)) {
      return new Date(value).toISOString();
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

/** Convert a whole result row, honoring the set of TIMESTAMP-like columns. */
export function toDisplayRow(
  row: Record<string, unknown>,
  columns: string[],
  timestampColumns: TimestampColumns = new Set()
): DisplayValue[] {
  return columns.map((c) => toDisplayValue(row[c], timestampColumns.has(c)));
}

/** Convert an array of result rows into a display matrix in column order. */
export function toDisplayRows(
  rows: Record<string, unknown>[],
  columns: string[],
  timestampColumns: TimestampColumns = new Set()
): DisplayValue[][] {
  return rows.map((r) => toDisplayRow(r, columns, timestampColumns));
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
