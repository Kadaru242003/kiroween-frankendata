// @vitest-environment node
/**
 * End-to-end through the SDK's in-memory transport: load the two mismatched
 * demo CSVs, autopsy, propose, apply with every proposal id, query the most
 * common species, and export CSV. Input files stay unchanged.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type TestHarness } from "./test-support";

let h: TestHarness;
let before: Record<string, string>;
beforeAll(async () => {
  h = await startHarness();
  before = Object.fromEntries(
    ["monsters.csv", "experiments.csv"].map((f) => [f, fs.readFileSync(path.join(h.root, f), "utf8")])
  );
}, 60000);
afterAll(() => h.close());

describe("frankendata MCP end to end", () => {
  let ids: string[] = [];
  let resultTable = "";

  it("lists the eight tools", async () => {
    const tools = (await h.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "frankendata_apply_recipe",
      "frankendata_apply_stitch",
      "frankendata_autopsy",
      "frankendata_export",
      "frankendata_load_files",
      "frankendata_propose_stitch",
      "frankendata_query",
      "frankendata_reset",
    ]);
  });

  it("loads the demo files", async () => {
    const r = await h.call("frankendata_load_files", { paths: ["monsters.csv", "experiments.csv"] });
    expect(r.isError).toBe(false);
    expect(r.data.tables.map((t: any) => [t.tableName, t.rowCount])).toEqual([
      ["monsters", 14],
      ["experiments", 13],
    ]);
  }, 60000);

  it("runs the autopsy", async () => {
    const r = await h.call("frankendata_autopsy", { table: "monsters" });
    expect(r.isError).toBe(false);
    expect(r.data.report.health.score).toBe(81);
    expect(r.data.report.duplicateRows).toBe(2);
  }, 60000);

  it("proposes a stitch with the rules engine only", async () => {
    const r = await h.call("frankendata_propose_stitch");
    expect(r.isError).toBe(false);
    expect(r.data.aiUsed).toBe(false);
    expect(r.data.matches.length).toBeGreaterThan(0);
    ids = [...r.data.matches.map((m: any) => m.id), ...r.data.cleanings.map((c: any) => c.id)];
  }, 60000);

  it("applies exactly the passed ids", async () => {
    const r = await h.call("frankendata_apply_stitch", { approvedIds: ids });
    expect(r.isError).toBe(false);
    resultTable = r.data.resultTable;
    expect(resultTable).toBe("stitch_1_result");
    expect(r.data.rowCount).toBe(12);
    const names = r.data.schema.map((c: any) => c.name);
    expect(names).toContain("Species");
  }, 60000);

  it("answers the most common species", async () => {
    const r = await h.call("frankendata_query", {
      sql: `SELECT Species, COUNT(*) AS n FROM ${resultTable} GROUP BY Species ORDER BY n DESC, Species LIMIT 1`,
    });
    expect(r.isError).toBe(false);
    expect(r.data.rows).toEqual([{ Species: "Swamp Wraith", n: 3 }]);
  }, 60000);

  it("exports CSV into the output folder and refuses to overwrite", async () => {
    const r = await h.call("frankendata_export", { table: resultTable, format: "csv" });
    expect(r.isError).toBe(false);
    expect(r.data.path).toBe(path.join("frankendata-output", "stitch_1_result.csv"));
    const text = fs.readFileSync(path.join(h.root, r.data.path), "utf8");
    expect(text.split("\r\n")).toHaveLength(13);
    const again = await h.call("frankendata_export", { table: resultTable, format: "csv" });
    expect(again.isError).toBe(true);
    expect(again.data.error.code).toBe("file-exists");
    const over = await h.call("frankendata_export", { table: resultTable, format: "csv", overwrite: true });
    expect(over.isError).toBe(false);
  }, 60000);

  it("never modified the input files", () => {
    for (const [f, text] of Object.entries(before)) {
      expect(fs.readFileSync(path.join(h.root, f), "utf8")).toBe(text);
    }
  });

  it("resets the session without touching files", async () => {
    const r = await h.call("frankendata_reset");
    expect(r.isError).toBe(false);
    expect(r.data.dropped).toContain("stitch_1_result");
    expect(fs.existsSync(path.join(h.root, "frankendata-output", "stitch_1_result.csv"))).toBe(true);
    const q = await h.call("frankendata_query", { sql: "SELECT 1 FROM monsters" });
    expect(q.isError).toBe(true);
    expect(q.data.error.code).toBe("sql-rejected");
  }, 60000);
});
