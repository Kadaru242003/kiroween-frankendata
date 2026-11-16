/**
 * A failed apply leaves the session exactly as it was: no leftover stitch_
 * tables, no plan, no stitched table, nothing to undo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBusinessFiles } from "../business-demo";
import { createTestLab, type TestLab } from "../recipes/recipe-test-lab";

let lab: TestLab;
beforeAll(async () => {
  lab = await createTestLab();
  await lab.load(await loadBusinessFiles());
}, 120000);
afterAll(() => lab.dispose());

const names = async (): Promise<string[]> =>
  (await lab.db.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables ORDER BY 1`)).map(
    (r) => r.name
  );

describe("a failed apply", () => {
  it("rejects and leaves tables and stores unchanged", async () => {
    const { plan } = await lab.approveAllPlan();
    expect(plan.approvedCleanings.length).toBeGreaterThan(0);
    const before = await names();

    const realQuery = lab.db.query.bind(lab.db);
    lab.db.query = (async (sql: string, ...rest: unknown[]) => {
      if (sql.includes('CREATE TABLE "stitch_1_result"')) throw new Error("boom");
      return (realQuery as (s: string, ...r: unknown[]) => Promise<unknown>)(sql, ...rest);
    }) as typeof lab.db.query;
    await expect(lab.controller.applyPlan(plan)).rejects.toThrow("boom");
    lab.db.query = realQuery as typeof lab.db.query;

    expect(await names()).toEqual(before);
    const state = lab.stitchStore.getState();
    expect(state.plan).toBeNull();
    expect(state.stitchedTable).toBeNull();
    expect(state.pendingUndo).toBeNull();
  }, 120000);
});
