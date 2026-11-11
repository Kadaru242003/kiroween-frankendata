/**
 * SQL identifier/literal escaping helpers for the stitching pipeline.
 *
 * These mirror the Feature-1 escaping rules used privately inside
 * `src/db/duckdb-service.ts` (double-quote identifiers, doubling embedded `"`;
 * single-quote literals, doubling embedded `'`). They are exposed here so the
 * stitching modules — `SampleReader` (task 4) and the `StitchApplier` SQL
 * generation (task 8) — build DuckDB SQL through one shared, tested helper
 * rather than concatenating identifiers or literals raw. This is what keeps an
 * adversarial table/column name or canonical value (e.g. `O'Brien`,
 * `"Night" Howler`, the word `SELECT`) a harmless data value rather than
 * something that can break or alter the generated SQL.
 */

/** Quote a SQL identifier (table/column name) by doubling embedded double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a SQL string literal by doubling embedded single quotes. */
export function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
