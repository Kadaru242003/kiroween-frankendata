/**
 * Shared generators and helpers for the Autopsy property tests (Feature 4).
 *
 * Test support only: imported solely by `*.test.ts` files. Provides fast-check
 * arbitraries for small mixed-type tables (with whitespace, case, null, and
 * duplicate patterns that exercise every finding) and a snapshot helper that
 * captures a table's schema, contents, and the set of tables in the catalog so
 * tests can prove an Autopsy changed nothing.
 */

import fc from "fast-check";
import { quoteIdent } from "../stitching/sql-escape.js";
import type { CellValue, ColumnSchema, ColumnType, DuckDBService } from "../types.js";

const STRINGS = ["Alpha", "alpha", " Alpha ", "Beta", "a  b", "x", "Swamp Wraith", "swamp-wraith"];

/** A cell of the given column type: mostly values, sometimes NULL. */
export function cellArb(type: ColumnType): fc.Arbitrary<CellValue> {
  switch (type) {
    case "number":
      return fc.option(fc.integer({ min: -50, max: 500 }).map(String), { nil: null });
    case "date":
      return fc.option(fc.constantFrom("2026-01-01", "2026-02-15", "2025-12-31"), { nil: null });
    case "boolean":
      return fc.option(fc.constantFrom("true", "false"), { nil: null });
    default:
      return fc.option(fc.constantFrom(...STRINGS), { nil: null });
  }
}

export interface GeneratedTable {
  schema: ColumnSchema[];
  rows: CellValue[][];
}

/** A small table of 1 to 3 columns of mixed types and 0 to 8 rows. */
export function tableArb(
  types: readonly ColumnType[] = ["string", "number", "date", "boolean"]
): fc.Arbitrary<GeneratedTable> {
  return fc
    .array(fc.constantFrom(...types), { minLength: 1, maxLength: 3 })
    .chain((colTypes) =>
      fc
        .array(fc.tuple(...colTypes.map((t) => cellArb(t))), { maxLength: 8 })
        .map((rows) => ({
          schema: colTypes.map((type, i) => ({ name: `c${i}`, type })),
          rows: rows as CellValue[][],
        }))
    );
}

let counter = 0;
/** A table name that is unique within a test file's DuckDB. */
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

/**
 * Serialize a table's schema and contents plus the full set of catalog tables.
 * Two equal snapshots mean nothing about the table, and no table, changed.
 */
export async function snapshot(service: DuckDBService, tableName: string): Promise<string> {
  const rows = await service.query(`SELECT * FROM ${quoteIdent(tableName)}`);
  const lit = tableName.replace(/'/g, "''");
  const cols = await service.query(
    `SELECT column_name, data_type FROM information_schema.columns ` +
      `WHERE table_name = '${lit}' ORDER BY ordinal_position`
  );
  const tables = await service.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`
  );
  return JSON.stringify({ rows, cols, tables }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v
  );
}
