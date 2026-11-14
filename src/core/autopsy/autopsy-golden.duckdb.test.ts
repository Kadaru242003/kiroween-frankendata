/**
 * DuckDB golden test for the Autopsy on the bundled mismatched demo data
 * (Feature 4, task 12; Requirement 9.7).
 *
 * Loads the two mismatched demo files through the REAL intake pipeline into a
 * real in-memory DuckDB, runs the Autopsy on each table, and pins the exact
 * findings. This is a regression anchor: if a rule, a query, or the score
 * formula changes, this fails loudly.
 *
 * monsters.csv (14 rows) carries the Gorzak row three times (2 duplicate rows)
 * and a Species column with inconsistent spellings: `Swamp Wraith` and
 * `swamp  wraith` (with a doubled space), `Moth Titan` and `moth titan`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { runAutopsy } from "./autopsy-engine";
import { createIntakeController } from "../intake-controller";
import { demoDataLoader } from "../demo-data-loader";
import { IntakeStore } from "../../state/intake-store";
import { createStitchController } from "../stitching/stitch-controller";
import { StitchStore } from "../stitching/stitch-store";
import { assembleStitchPlan } from "../stitching/plan-assembly";
import type { ApprovalDecision } from "../stitching/types";
import type { LoadedTable } from "../types";
import type { AutopsyReport } from "./types";

let duck: TestDuckDB;
let loadedTables: readonly LoadedTable[] = [];
const reports: Record<string, AutopsyReport> = {};

beforeAll(async () => {
  duck = await createTestDuckDB();
  const store = new IntakeStore();
  const intake = createIntakeController({ duckDBService: duck.service, store });
  await intake.intake(await demoDataLoader.loadMismatched());
  expect(store.getState().errors).toEqual([]);
  loadedTables = store.getState().tables;
  for (const t of store.getState().tables) {
    reports[t.tableName] = await runAutopsy(duck.service, {
      tableName: t.tableName,
      schema: t.schema,
      rowCount: t.rowCount,
    });
  }
}, 60_000);

afterAll(() => duck?.dispose());

const col = (r: AutopsyReport, name: string) => r.columns.find((c) => c.name === name)!;

describe("Autopsy golden: mismatched demo monsters table", () => {
  it("pins the table-level findings", () => {
    const r = reports.monsters;
    expect(r.status).toBe("ok");
    expect(r.complete).toBe(true);
    expect(r.rows).toBe(14);
    expect(r.columnCount).toBe(4);
    expect(r.duplicateRows).toBe(2);
    expect(r.candidateKeys).toEqual([]);
    expect(r.allNullColumns).toEqual([]);
    expect(r.constantColumns).toEqual([]);
  });

  it("pins the health score and its breakdown (the worked example from the design)", () => {
    const r = reports.monsters;
    expect(r.health.score).toBe(81);
    expect(r.health.breakdown.map((d) => [d.code, d.points])).toEqual([
      ["duplicates", 14],
      ["whitespace", 2],
      ["variants", 3],
    ]);
  });

  it("pins the Species whitespace, casing, and category variants", () => {
    const s = col(reports.monsters, "Species");
    expect(s.distinct).toBe(8);
    expect(s.whitespaceRows).toBe(1); // "swamp  wraith"
    expect(s.caseVariantGroups).toBe(2); // swamp wraith, moth titan
    expect(s.categoryVariants).toBe(4);
    expect(s.status).toBe("warning");
    expect(s.topValues?.[0]).toEqual({ value: "Swamp Wraith", count: 4 });
  });

  it("pins the other columns", () => {
    const r = reports.monsters;
    expect(col(r, "Monster_Name").distinct).toBe(12);
    expect(col(r, "Monster_Name").topValues?.[0]).toEqual({ value: "Gorzak", count: 3 });
    expect(col(r, "Monster_Name").status).toBe("healthy");
    expect(col(r, "Threat_Level").topValues).toEqual([
      { value: "High", count: 8 },
      { value: "Low", count: 4 },
      { value: "Medium", count: 2 },
    ]);
    expect(col(r, "Sedated").type).toBe("boolean");
    expect(col(r, "Sedated").topValues).toEqual([
      { value: "true", count: 8 },
      { value: "false", count: 6 },
    ]);
  });

  it("offers Fix it actions that are the existing cleaning proposal ids", () => {
    expect(reports.monsters.fixes.map((f) => f.proposalId)).toEqual([
      "clean:whitespace:monsters.Species",
      "clean:case:monsters.Species",
      "clean:category:monsters.Species",
      "clean:duplicate-rows:monsters",
    ]);
    const dup = reports.monsters.fixes.find((f) => f.kind === "duplicate-rows")!;
    const p = dup.proposal as { before: { rowCount: number }; after: { rowCount: number } };
    expect(p.before.rowCount - p.after.rowCount).toBe(2);
  });
});

describe("Autopsy golden: mismatched demo experiments table", () => {
  it("pins the findings, score, and fixes", () => {
    const r = reports.experiments;
    expect(r.rows).toBe(13);
    expect(r.duplicateRows).toBe(1); // the Blinky observation is repeated once
    expect(r.health.score).toBe(89);
    expect(r.health.breakdown.map((d) => [d.code, d.points])).toEqual([
      ["duplicates", 8],
      ["variants", 3],
    ]);
    const s = col(r, "species");
    expect(s.caseVariantGroups).toBe(3);
    expect(s.categoryVariants).toBe(6);
    expect(s.whitespaceRows).toBe(0);
    expect(r.fixes.map((f) => f.proposalId)).toEqual([
      "clean:case:experiments.species",
      "clean:category:experiments.species",
      "clean:duplicate-rows:experiments",
    ]);
  });
});

describe("Autopsy Fix it hands existing proposals to the existing approval flow", () => {
  it("the stitch controller computes the same ids for a single loaded table, and the plan applies and undoes", async () => {
    const monsters = loadedTables.find((t) => t.tableName === "monsters")!;
    const store = new StitchStore();
    const controller = createStitchController({
      db: duck.service,
      getTables: () => [monsters],
      store,
    });

    // The exact step App.handleFixIt takes when the store has no proposals yet.
    const proposals = await controller.computeProposals();
    const offered = reports.monsters.fixes.map((f) => f.proposalId);
    const computed = proposals.cleanings.map((c) => c.id);
    for (const id of offered) {
      expect(computed).toContain(id);
    }

    // Approve every offered fix, assemble the plan, and apply it (cleanup only).
    const decisions: Record<string, ApprovalDecision> = {};
    for (const id of offered) {
      decisions[id] = { proposalId: id, decision: "approved" };
      store.setDecision(decisions[id]);
    }
    const plan = assembleStitchPlan(proposals, decisions, [monsters]);
    const stitched = await controller.applyPlan(plan);
    expect(stitched.rowCount).toBe(12); // 14 rows minus the 2 duplicate Gorzak rows

    // The original is untouched, and Undo stitch removes the cleaned copies.
    expect(await duck.service.getRowCount("monsters")).toBe(14);
    await controller.undo();
    const left = await duck.service.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'stitch%'"
    );
    expect(left).toEqual([]);
  });
});
