// @vitest-environment node
/**
 * Feature: frankendata-mcp, Property 3: apply_stitch never changes the original
 * tables and creates only stitch_ tables.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type TestHarness } from "./test-support";

let h: TestHarness;
let ids: string[] = [];

async function snapshot(): Promise<string> {
  const out: unknown[] = [];
  for (const sql of [
    "SELECT * FROM monsters ORDER BY ALL",
    "SELECT * FROM experiments ORDER BY ALL",
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('monsters','experiments') ORDER BY ALL",
  ]) {
    out.push((await h.app.session.db().then((d) => d.query(sql))).map((r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? Number(v) : v))));
  }
  return JSON.stringify(out);
}
async function tableNames(): Promise<string[]> {
  const db = await h.app.session.db();
  const rows = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name"
  );
  return rows.map((r) => String(r.table_name));
}

beforeAll(async () => {
  h = await startHarness();
  await h.call("frankendata_load_files", { paths: ["monsters.csv", "experiments.csv"] });
  const p = await h.call("frankendata_propose_stitch");
  ids = [...p.data.matches.map((m: any) => m.id), ...p.data.cleanings.map((c: any) => c.id)];
}, 60000);
afterAll(() => h.close());

describe("Feature: frankendata-mcp, Property 3: originals stay unchanged", () => {
  it("any approved subset leaves the original tables untouched and creates only stitch_ tables", async () => {
    const before = await snapshot();
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(ids),
        fc.constantFrom(undefined, "monsters", "experiments"),
        async (subset, anchor) => {
          const r = await h.call("frankendata_apply_stitch", { approvedIds: subset, ...(anchor ? { anchor } : {}) });
          expect(r.isError).toBe(false);
          expect(r.data.createdTables.every((t: string) => t.startsWith("stitch_"))).toBe(true);
          expect(await snapshot()).toBe(before);
          const names = await tableNames();
          expect(names.filter((n) => !n.startsWith("stitch_"))).toEqual(["experiments", "monsters"]);
        }
      ),
      { numRuns: 12 }
    );
  }, 240000);
});
