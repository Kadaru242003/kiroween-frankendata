/**
 * A number-to-text key match must apply instead of failing with a DuckDB
 * conversion error, keep every anchor row, and leave no orphan tables.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestLab, type TestLab } from "../recipes/recipe-test-lab";

const csv = (name: string, text: string) => new File([text], name, { type: "text/csv" });

let lab: TestLab;
beforeAll(async () => {
  lab = await createTestLab();
  await lab.load([
    csv("n.csv", "id,v\n1,a\n2,b\n"),
    csv("s.csv", "id,w\nx1,a\nx2,b\n"),
  ]);
}, 120000);
afterAll(() => lab.dispose());

describe("mixed number and text join keys", () => {
  it("applies the approved plan, keeps all anchor rows, and undo leaves only the originals", async () => {
    const { plan } = await lab.approveAllPlan();
    expect(plan.approvedMatches.length).toBeGreaterThan(0);

    const before = (await lab.db.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables ORDER BY 1`)).map((r) => r.name);
    const stitched = await lab.controller.applyPlan(plan);
    const count = await lab.db.query<{ c: number | bigint }>(`SELECT count(*) AS c FROM ${stitched.tableName}`);
    expect(Number(count[0]?.c)).toBeGreaterThanOrEqual(2);

    await lab.controller.undo();
    const after = (await lab.db.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables ORDER BY 1`)).map((r) => r.name);
    expect(after).toEqual(before);
  }, 120000);
});
