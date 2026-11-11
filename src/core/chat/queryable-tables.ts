/**
 * Build the list of {@link QueryableTable}s "Ask the Lab" may query (Feature 3,
 * task 6).
 *
 * The queryable set is the current intake {@link LoadedTable}s PLUS the Feature
 * 2 `stitch_<n>_result` and `stitch_<n>_clean_*` tables that currently exist in
 * DuckDB (Req: query loaded tables including stitch results). The intake tables
 * carry their schema already; the stitch tables are discovered from
 * `information_schema` so the list refreshes correctly after a stitch is
 * applied or undone (the stitch tables appear/disappear in DuckDB).
 *
 * Framework-agnostic: reads only through {@link DuckDBService.query}.
 */

import type { ColumnType, DuckDBService, LoadedTable } from "../types.js";
import type { QueryableColumn, QueryableTable } from "./types.js";

/** A stitch table name: stitch_<n>_result or stitch_<n>_clean_<name>. */
const STITCH_TABLE_RE = /^stitch_\d+_(result|clean_.+)$/;

/** Map a DuckDB `data_type` string to a Feature 1 {@link ColumnType}. */
function duckDbTypeToColumnType(dataType: string): ColumnType {
  const t = dataType.trim().toUpperCase();
  if (t === "BOOLEAN") return "boolean";
  if (t === "DATE" || t.startsWith("TIMESTAMP")) return "date";
  if (t === "VARCHAR" || t === "CHAR" || t.startsWith("VARCHAR")) return "string";
  // DOUBLE, DECIMAL(..), BIGINT, HUGEINT, INTEGER, … are all numeric.
  if (
    t === "DOUBLE" ||
    t === "REAL" ||
    t === "FLOAT" ||
    t.startsWith("DECIMAL") ||
    t.endsWith("INT") ||
    t === "HUGEINT" ||
    t === "UHUGEINT"
  ) {
    return "number";
  }
  // Unknown types are treated as strings (safe default for display/validation).
  return "string";
}

interface InfoSchemaRow {
  table_name: string;
  column_name: string;
  data_type: string;
  ordinal_position: number | bigint;
}

/**
 * Discover the currently-present `stitch_*` tables and their columns from
 * `information_schema`, returning them as {@link QueryableTable}s in a stable
 * order (by table name, then column ordinal). Returns `[]` on any query error
 * so a discovery failure never breaks the panel.
 */
export async function discoverStitchTables(
  db: DuckDBService
): Promise<QueryableTable[]> {
  let rows: InfoSchemaRow[];
  try {
    rows = await db.query<InfoSchemaRow>(
      "SELECT table_name, column_name, data_type, ordinal_position " +
        "FROM information_schema.columns " +
        "ORDER BY table_name, ordinal_position"
    );
  } catch {
    return [];
  }

  const byTable = new Map<string, QueryableColumn[]>();
  for (const r of rows) {
    const name = String(r.table_name);
    if (!STITCH_TABLE_RE.test(name)) continue;
    const cols = byTable.get(name) ?? [];
    cols.push({
      name: String(r.column_name),
      type: duckDbTypeToColumnType(String(r.data_type)),
    });
    byTable.set(name, cols);
  }

  return [...byTable.entries()].map(([tableName, columns]) => ({
    tableName,
    columns,
  }));
}

/** Convert a Feature 1 {@link LoadedTable} to a {@link QueryableTable}. */
export function loadedToQueryable(table: LoadedTable): QueryableTable {
  return {
    tableName: table.tableName,
    columns: table.schema.map((c) => ({ name: c.name, type: c.type })),
  };
}

/**
 * Build the full queryable-table list: the intake tables first (in load order),
 * then any discovered `stitch_*` tables not already present by name.
 */
export async function buildQueryableTables(
  db: DuckDBService,
  loaded: readonly LoadedTable[]
): Promise<QueryableTable[]> {
  const result: QueryableTable[] = loaded.map(loadedToQueryable);
  const seen = new Set(result.map((t) => t.tableName));
  for (const stitch of await discoverStitchTables(db)) {
    if (!seen.has(stitch.tableName)) {
      result.push(stitch);
      seen.add(stitch.tableName);
    }
  }
  return result;
}
