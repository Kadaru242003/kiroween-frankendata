/**
 * Unit tests for SchemaSummary budgeting (Feature 3, task 4).
 *
 * Covers design "SchemaSummary budgeting" and Requirements 3.3, 3.4: table
 * priority order (result → original → clean), caps on tables/columns/samples,
 * per-sample char truncation, and byte-budget trimming from the end.
 */

import { describe, expect, it } from "vitest";
import {
  buildSchemaSummary,
  orderTablesForSchema,
  type SchemaSourceTable,
} from "./schema-builder";
import {
  ASK_SCHEMA_MAX_TABLES,
  ASK_SCHEMA_MAX_COLUMNS_PER_TABLE,
  ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN,
  ASK_SCHEMA_MAX_SAMPLE_CHARS,
  ASK_SCHEMA_MAX_PAYLOAD_BYTES,
  type QueryableTable,
} from "./types";
import type { SampleReader, SampleSourceTable } from "../stitching/sample-reader";
import type { TableSample } from "../stitching/types";

/**
 * A fake SampleReader that returns `samplesPerColumn` copies of a given value
 * per column, so budgeting/truncation can be asserted without DuckDB.
 */
function fakeReader(valueFor: (col: string) => string, samplesPerColumn = 5): SampleReader {
  async function readTable(table: SampleSourceTable): Promise<TableSample> {
    const samplesByColumn: Record<string, { value: string; count: number }[]> = {};
    for (const c of table.schema) {
      samplesByColumn[c.name] = Array.from({ length: samplesPerColumn }, (_, i) => ({
        value: valueFor(c.name) + i,
        count: samplesPerColumn - i,
      }));
    }
    return {
      tableName: table.tableName,
      rowCount: table.rowCount,
      schema: table.schema.map((c) => ({ ...c })),
      samplesByColumn,
    };
  }
  return {
    readTable,
    readTables: async (tables) => Promise.all(tables.map(readTable)),
  };
}

function qt(tableName: string, cols: number): SchemaSourceTable {
  const columns: QueryableTable["columns"] = Array.from({ length: cols }, (_, i) => ({
    name: `c${i}`,
    type: "string" as const,
  }));
  return { tableName, columns, rowCount: 100 };
}

describe("orderTablesForSchema", () => {
  it("orders result → original → clean, stable within rank", () => {
    const tables: QueryableTable[] = [
      { tableName: "stitch_1_clean_monsters", columns: [] },
      { tableName: "monsters", columns: [] },
      { tableName: "stitch_1_result", columns: [] },
      { tableName: "experiments", columns: [] },
    ];
    const ordered = orderTablesForSchema(tables).map((t) => t.tableName);
    expect(ordered).toEqual([
      "stitch_1_result",
      "monsters",
      "experiments",
      "stitch_1_clean_monsters",
    ]);
  });
});

describe("buildSchemaSummary", () => {
  it("includes names, types, and bounded samples; never full rows", async () => {
    const reader = fakeReader((c) => `${c}_v`);
    const summary = await buildSchemaSummary(reader, [qt("monsters", 2)]);
    expect(summary.tables).toHaveLength(1);
    const col = summary.tables[0].columns[0];
    expect(col.name).toBe("c0");
    expect(col.type).toBe("string");
    expect(col.samples.length).toBeLessThanOrEqual(ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN);
  });

  it("truncates sample values to ASK_SCHEMA_MAX_SAMPLE_CHARS", async () => {
    const long = "x".repeat(ASK_SCHEMA_MAX_SAMPLE_CHARS + 50);
    const reader = fakeReader(() => long);
    const summary = await buildSchemaSummary(reader, [qt("t", 1)]);
    for (const s of summary.tables[0].columns[0].samples) {
      expect(s.length).toBeLessThanOrEqual(ASK_SCHEMA_MAX_SAMPLE_CHARS);
    }
  });

  it("caps columns per table", async () => {
    const reader = fakeReader((c) => c);
    const summary = await buildSchemaSummary(reader, [
      qt("wide", ASK_SCHEMA_MAX_COLUMNS_PER_TABLE + 10),
    ]);
    expect(summary.tables[0].columns.length).toBe(ASK_SCHEMA_MAX_COLUMNS_PER_TABLE);
  });

  it("caps the number of tables", async () => {
    const reader = fakeReader((c) => c);
    const many: SchemaSourceTable[] = Array.from(
      { length: ASK_SCHEMA_MAX_TABLES + 5 },
      (_, i) => qt(`t${i}`, 1)
    );
    const summary = await buildSchemaSummary(reader, many);
    expect(summary.tables.length).toBe(ASK_SCHEMA_MAX_TABLES);
  });

  it("trims from the end to stay within the byte budget", async () => {
    // Big samples so each table is heavy; many tables so the budget is exceeded.
    const reader = fakeReader(() => "y".repeat(ASK_SCHEMA_MAX_SAMPLE_CHARS));
    const heavy: SchemaSourceTable[] = Array.from({ length: ASK_SCHEMA_MAX_TABLES }, (_, i) =>
      qt(`t${i}`, ASK_SCHEMA_MAX_COLUMNS_PER_TABLE)
    );
    const summary = await buildSchemaSummary(reader, heavy);
    const bytes = new TextEncoder().encode(JSON.stringify(summary)).length;
    expect(bytes).toBeLessThanOrEqual(ASK_SCHEMA_MAX_PAYLOAD_BYTES);
    // At least the highest-priority table survives.
    expect(summary.tables.length).toBeGreaterThanOrEqual(1);
  });
});
