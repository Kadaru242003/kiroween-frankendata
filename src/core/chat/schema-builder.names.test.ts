import { describe, expect, it } from "vitest";
import { buildSchemaSummary, type SchemaSourceTable } from "./schema-builder";
import { ASK_SCHEMA_MAX_NAME_CHARS } from "./types";
import type { SampleReader, SampleSourceTable } from "../stitching/sample-reader";
import type { TableSample } from "../stitching/types";

const reader: SampleReader = {
  async readTable(table: SampleSourceTable): Promise<TableSample> {
    return { tableName: table.tableName, rowCount: table.rowCount, schema: table.schema.map((c) => ({ ...c })), samplesByColumn: {} };
  },
  readTables: async (tables) => Promise.all(tables.map((t) => reader.readTable(t))),
};

describe("schema summary names stay within the proxy's name limit", () => {
  it("leaves out a column or table whose name is longer than the limit, so the request is never rejected", async () => {
    const tooLong = "x".repeat(ASK_SCHEMA_MAX_NAME_CHARS + 1);
    const ok = "y".repeat(ASK_SCHEMA_MAX_NAME_CHARS);
    const tables: SchemaSourceTable[] = [
      {
        tableName: "monsters",
        rowCount: 1,
        columns: [
          { name: "id", type: "number" },
          { name: tooLong, type: "string" },
          { name: ok, type: "string" },
        ],
      },
      { tableName: tooLong, rowCount: 1, columns: [{ name: "a", type: "string" }] },
    ];
    const summary = await buildSchemaSummary(reader, tables);
    expect(summary.tables.map((t) => t.tableName)).toEqual(["monsters"]);
    expect(summary.tables[0].columns.map((c) => c.name)).toEqual(["id", ok]);
  });
});
