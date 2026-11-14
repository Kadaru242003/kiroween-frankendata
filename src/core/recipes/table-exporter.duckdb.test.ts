import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { exportTable } from "./table-exporter";

let lab: TestDuckDB;
const schema = [
  { name: "name", type: "string" as const },
  { name: "n", type: "number" as const },
  { name: "d", type: "date" as const },
];
beforeAll(async () => {
  lab = await createTestDuckDB();
  await lab.service.createTable("exp_t", schema, [
    ["Gorzak", "1.5", "2026-01-05"],
    ["Wisp", null, null],
    ['Say "hi", ok', "3", "2025-12-25"],
  ]);
});
afterAll(() => lab.dispose());

// Parquet is not exercised here: the node-blocking MVP bundle cannot load
// DuckDB's Parquet extension (it is a loadable extension, see NOTES.md).
describe("export with a real DuckDB", () => {
  it("exports CSV with ISO dates and NULL as empty", async () => {
    const f = await exportTable(lab.service, { tableName: "exp_t", schema, rowCount: 3 }, "csv");
    const lines = String(f.data).split("\r\n");
    expect(lines[0]).toBe("name,n,d");
    expect(lines[1]).toBe("Gorzak,1.5,2026-01-05");
    expect(lines[2]).toBe("Wisp,,");
    expect(lines[3]).toBe('"Say ""hi"", ok",3,2025-12-25');
  });

  it("reports a clear message for a missing table", async () => {
    await expect(
      exportTable(lab.service, { tableName: "nope", schema, rowCount: 0 }, "csv")
    ).rejects.toThrow(/Could not export nope/);
  });
});
