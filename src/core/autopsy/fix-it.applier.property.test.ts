/**
 * Property-based test: Fix it proposals are accepted by the existing applier.
 *
 * Feature: frankendata-autopsy, Property 5: every FixAction proposal is
 * accepted by the existing applier, leaves the original table unchanged, and a
 * duplicate-rows proposal yields a result with the original row count minus
 * the duplicates.
 *
 * Validates: Requirements 5.2, 5.4, 9.5
 *
 * Uses the real StitchController (the same apply path the approval screen
 * uses) with a cleaning-only plan over a single table.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { runAutopsy } from "./autopsy-engine";
import { snapshot, tableArb, uniqueName } from "./autopsy-test-support";
import { createStitchController } from "../stitching/stitch-controller";
import { StitchStore } from "../stitching/stitch-store";
import { assembleStitchPlan } from "../stitching/plan-assembly";
import type { ApprovalDecision, CleaningProposal } from "../stitching/types";
import type { LoadedTable } from "../types";

let duck: TestDuckDB;
beforeAll(async () => {
  duck = await createTestDuckDB();
});
afterAll(() => duck?.dispose());

/** Build and apply a cleaning-only plan through the real controller. */
async function applyOnly(
  loaded: LoadedTable,
  cleanings: CleaningProposal[]
): Promise<{ rowCount: number; undo: () => Promise<void> }> {
  const store = new StitchStore();
  const controller = createStitchController({
    db: duck.service,
    getTables: () => [loaded],
    store,
  });
  const decisions: Record<string, ApprovalDecision> = {};
  for (const c of cleanings) {
    decisions[c.id] = { proposalId: c.id, decision: "approved" };
  }
  const plan = assembleStitchPlan(
    { matches: [], cleanings, aiUsed: false },
    decisions,
    [loaded]
  );
  const stitched = await controller.applyPlan(plan);
  return { rowCount: stitched.rowCount, undo: () => controller.undo() };
}

/**
 * Drop any stitch_ tables left behind, so one failed run can never poison the
 * next (every apply names its result `stitch_1_result`).
 */
async function dropStitchTables(): Promise<void> {
  const rows = await duck.service.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables ` +
      `WHERE table_schema = 'main' AND table_name LIKE 'stitch%'`
  );
  for (const r of rows) {
    await duck.service.query(`DROP TABLE IF EXISTS "${String(r.table_name).replace(/"/g, '""')}"`);
  }
}

describe("Property 5: every Fix it proposal is accepted by the existing applier", () => {
  it("applies cleanly, leaves the original unchanged, and removes exactly the rule's duplicates", async () => {
    let exercised = 0;
    await fc.assert(
      fc.asyncProperty(tableArb(["string", "number"]), async ({ schema, rows }) => {
        await dropStitchTables();
        const name = uniqueName("fix");
        const loaded = await duck.service.createTable(name, schema, rows);
        const target = { tableName: name, schema: loaded.schema, rowCount: loaded.rowCount };
        const report = await runAutopsy(duck.service, target);
        fc.pre(report.fixes.length > 0);
        exercised += 1;

        const before = await snapshot(duck.service, name);
        try {
          // (a) Applying every offered fix together is accepted.
          const all = await applyOnly(loaded, report.fixes.map((f) => f.proposal));
          expect(all.rowCount).toBeGreaterThanOrEqual(0);
          expect(all.rowCount).toBeLessThanOrEqual(loaded.rowCount);
          await all.undo();

          // (b) A duplicate-rows proposal alone removes exactly its own count,
          // which is at least the exact duplicates in the report.
          const dup = report.fixes.find((f) => f.kind === "duplicate-rows");
          if (dup) {
            const payload = dup.proposal as { before: { rowCount: number }; after: { rowCount: number } };
            const removed = payload.before.rowCount - payload.after.rowCount;
            expect(removed).toBeGreaterThanOrEqual(report.duplicateRows);
            const only = await applyOnly(loaded, [dup.proposal]);
            expect(only.rowCount).toBe(loaded.rowCount - removed);
            await only.undo();
          }

          // The original table and the catalog are exactly as before (clean
          // copies were dropped by the undo, the original was never written).
          expect(await snapshot(duck.service, name)).toBe(before);
        } finally {
          await dropStitchTables();
        }
      }),
      { numRuns: 25 }
    );
    expect(exercised).toBeGreaterThan(3);
  }, 120_000);
});
