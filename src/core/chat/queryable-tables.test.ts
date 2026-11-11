/**
 * Unit tests for queryable-table discovery (Feature 3, task 6).
 *
 * Covers building the queryable set from intake tables plus the present
 * `stitch_<n>_result` / `stitch_<n>_clean_*` tables discovered via
 * information_schema, with DuckDB type → ColumnType mapping. Uses a fake
 * DuckDBService (no real DuckDB).
 */

import { describe, expect, it } from "vitest";
import {
  buildQueryableTables,
  discoverStitchTables,
  loadedToQueryable,
} from "./queryable-tables";
import type { DuckDBService, LoadedTable } from "../types";

interface InfoRow {
  table_name: string;
  column_name: string;
  data_type: string;
  ordinal_position: number;
}

function fakeDb(infoRows: InfoRow[]): DuckDBService {
  return {
    init: async () => {},
    createTable: async () => {
      throw new Error("unused");
    },
    getRowCount: async () => 0,
    getPreviewRows: async () => [],
    query: (async () => infoRows) as DuckDBService["query"],
  };
}

const monsters: LoadedTable = {
  loadId: 1,
  tableName: "monsters",
  sourceFileName: "monsters.csv",
  schema: [
    { name: "name", type: "string" },
    { name: "power", type: "number" },
  ],
  rowCount: 12,
};

describe("loadedToQueryable", () => {
  it("maps a LoadedTable to a QueryableTable", () => {
    expect(loadedToQueryable(monsters)).toEqual({
      tableName: "monsters",
      columns: [
        { name: "name", type: "string" },
        { name: "power", type: "number" },
      ],
    });
  });
});

describe("discoverStitchTables", () => {
  it("returns only stitch_* tables with mapped column types", async () => {
    const db = fakeDb([
      { table_name: "monsters", column_name: "name", data_type: "VARCHAR", ordinal_position: 1 },
      { table_name: "stitch_1_result", column_name: "species", data_type: "VARCHAR", ordinal_position: 1 },
      { table_name: "stitch_1_result", column_name: "count", data_type: "BIGINT", ordinal_position: 2 },
      { table_name: "stitch_1_clean_monsters", column_name: "is_outlier", data_type: "BOOLEAN", ordinal_position: 1 },
      { table_name: "stitch_1_clean_monsters", column_name: "when", data_type: "TIMESTAMP", ordinal_position: 2 },
    ]);
    const out = await discoverStitchTables(db);
    const names = out.map((t) => t.tableName).sort();
    expect(names).toEqual(["stitch_1_clean_monsters", "stitch_1_result"]);
    const result = out.find((t) => t.tableName === "stitch_1_result")!;
    expect(result.columns).toEqual([
      { name: "species", type: "string" },
      { name: "count", type: "number" },
    ]);
    const clean = out.find((t) => t.tableName === "stitch_1_clean_monsters")!;
    expect(clean.columns).toEqual([
      { name: "is_outlier", type: "boolean" },
      { name: "when", type: "date" },
    ]);
  });

  it("returns [] when the info-schema query fails", async () => {
    const db: DuckDBService = {
      ...fakeDb([]),
      query: (async () => {
        throw new Error("no info schema");
      }) as DuckDBService["query"],
    };
    expect(await discoverStitchTables(db)).toEqual([]);
  });
});

describe("buildQueryableTables", () => {
  it("is empty when there are no loaded or stitch tables", async () => {
    expect(await buildQueryableTables(fakeDb([]), [])).toEqual([]);
  });

  it("lists intake tables first, then discovered stitch tables", async () => {
    const db = fakeDb([
      { table_name: "stitch_1_result", column_name: "x", data_type: "DOUBLE", ordinal_position: 1 },
    ]);
    const out = await buildQueryableTables(db, [monsters]);
    expect(out.map((t) => t.tableName)).toEqual(["monsters", "stitch_1_result"]);
  });

  it("does not duplicate a table already present by name", async () => {
    const db = fakeDb([
      { table_name: "monsters", column_name: "name", data_type: "VARCHAR", ordinal_position: 1 },
    ]);
    // monsters is not a stitch_* name, so it is filtered from discovery anyway;
    // this asserts intake tables are never doubled.
    const out = await buildQueryableTables(db, [monsters]);
    expect(out.map((t) => t.tableName)).toEqual(["monsters"]);
  });
});
