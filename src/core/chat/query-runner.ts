/**
 * Real DuckDB-backed QueryRunner for "Ask the Lab" (Feature 3, bug fix).
 *
 * {@link createDuckDbQueryRunner} turns a validator-accepted (and fetch-capped)
 * SQL string into a {@link QueryExecResult} for the {@link AskController}. It
 * was extracted from `App.tsx` so the column-type logic is testable without
 * React.
 *
 * ## Why the column types matter
 *
 * DuckDB-WASM's raw `query` path returns DATE/TIMESTAMP cells as epoch-ms
 * numbers (not Date objects) and carries NO column-type info, so a naive runner
 * showed `MIN(captured_on)` as `1764460800000` instead of `2025-11-30`. This
 * runner asks DuckDB itself for the result's column types via `DESCRIBE <sql>`
 * and builds the DATE and TIMESTAMP-family column sets, which the controller's
 * {@link toDisplayRows} uses to render DATE columns as `YYYY-MM-DD` and
 * TIMESTAMP columns as full ISO strings.
 *
 * The `DESCRIBE` is best-effort: if it fails for any reason the runner falls
 * back to the previous behavior (columns derived from the first row, no
 * temporal hints) and NEVER throws for the type lookup — a real query error
 * still rejects so the controller can drive its repair path.
 */

import type { DuckDBService } from "../types.js";
import type { QueryExecResult, QueryRunner } from "./ask-controller.js";

/** One row of `DESCRIBE <sql>` in DuckDB. */
interface DescribeRow {
  column_name: string;
  column_type: string;
}

/**
 * Classify a DuckDB `column_type` string as a DATE, a TIMESTAMP-family type, or
 * neither. TIME (and TIME WITH TIME ZONE) are intentionally NOT treated as
 * temporal-instant columns here (they are not epoch-ms dates).
 */
function temporalClass(columnType: string): "date" | "timestamp" | null {
  const t = columnType.trim().toUpperCase();
  if (t === "DATE") return "date";
  // TIMESTAMP, TIMESTAMP WITH TIME ZONE, TIMESTAMPTZ, TIMESTAMP_S/_MS/_NS.
  if (t === "TIMESTAMP" || t.startsWith("TIMESTAMP")) return "timestamp";
  return null;
}

/**
 * Read the result column types for `sql` via `DESCRIBE`, returning the DATE and
 * TIMESTAMP column-name sets. Returns empty sets on any failure (best-effort —
 * never throws), so the runner degrades to the prior no-hint behavior.
 */
async function describeTemporalColumns(
  service: DuckDBService,
  sql: string,
): Promise<{ dateColumns: Set<string>; timestampColumns: Set<string> }> {
  const dateColumns = new Set<string>();
  const timestampColumns = new Set<string>();
  try {
    const described = await service.query<DescribeRow>(`DESCRIBE ${sql}`);
    for (const row of described) {
      const name = String(row.column_name ?? "");
      if (!name) continue;
      const kind = temporalClass(String(row.column_type ?? ""));
      if (kind === "date") dateColumns.add(name);
      else if (kind === "timestamp") timestampColumns.add(name);
    }
  } catch {
    // Type lookup is best-effort; fall back to no temporal hints.
  }
  return { dateColumns, timestampColumns };
}

/**
 * Create a {@link QueryRunner} backed by a {@link DuckDBService}. Executes the
 * SQL, derives the ordered columns (DuckDB preserves SELECT order in each row
 * object's key order), and attaches the DATE/TIMESTAMP column sets from a
 * best-effort `DESCRIBE` so the converter renders dates readably.
 */
export function createDuckDbQueryRunner(service: DuckDBService): QueryRunner {
  return async (sql: string): Promise<QueryExecResult> => {
    // The real query runs first; a DuckDB error here must propagate so the
    // controller can attempt a repair.
    const rows = await service.query<Record<string, unknown>>(sql);
    const { dateColumns, timestampColumns } = await describeTemporalColumns(
      service,
      sql,
    );
    // Prefer DESCRIBE's column order; fall back to the first row's keys.
    const describedOrder = [...dateColumns, ...timestampColumns];
    const columns =
      rows.length > 0
        ? Object.keys(rows[0])
        : describedOrder.length > 0
          ? describedOrder
          : [];
    return { columns, rows, dateColumns, timestampColumns };
  };
}
