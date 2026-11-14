/**
 * Test support: a real, in-memory "lab" (DuckDB + intake + stitch stack) for the
 * DuckDB-backed recipe tests. Imported only by tests.
 */
import { IntakeStore } from "../../state/intake-store";
import { dropAllTables } from "../chat/reset-lab";
import { createIntakeController } from "../intake-controller";
import { assembleStitchPlan } from "../stitching/plan-assembly";
import { createStitchController } from "../stitching/stitch-controller";
import { StitchStore } from "../stitching/stitch-store";
import type { ApprovalDecision, StitchPlan } from "../stitching/types";
import type { DuckDBService, LoadedTable } from "../types";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";

export interface TestLab {
  db: DuckDBService;
  intake: IntakeStore;
  stitchStore: StitchStore;
  controller: ReturnType<typeof createStitchController>;
  load(files: File[]): Promise<LoadedTable[]>;
  tables(): readonly LoadedTable[];
  /** Approve every proposal and assemble the plan (the "approve all" flow). */
  approveAllPlan(): Promise<{ plan: StitchPlan; decisions: Record<string, ApprovalDecision> }>;
  /** Drop every table and clear both stores (Reset lab). */
  reset(): Promise<void>;
  dispose(): void;
}

export async function createTestLab(): Promise<TestLab> {
  const duck: TestDuckDB = await createTestDuckDB();
  const db = duck.service;
  const intake = new IntakeStore();
  const stitchStore = new StitchStore();
  const controller = createStitchController({
    db,
    getTables: () => intake.getState().tables,
    store: stitchStore,
  });
  const intakeController = createIntakeController({ duckDBService: db, store: intake });
  return {
    db,
    intake,
    stitchStore,
    controller,
    tables: () => intake.getState().tables,
    async load(files) {
      await intakeController.intake(files);
      if (intake.getState().errors.length > 0) {
        throw new Error(`intake errors: ${JSON.stringify(intake.getState().errors)}`);
      }
      return [...intake.getState().tables];
    },
    async approveAllPlan() {
      const proposals = await controller.computeProposals();
      const decisions: Record<string, ApprovalDecision> = {};
      for (const m of proposals.matches) decisions[m.id] = { proposalId: m.id, decision: "approved" };
      for (const c of proposals.cleanings) decisions[c.id] = { proposalId: c.id, decision: "approved" };
      const plan = assembleStitchPlan(proposals, decisions, intake.getState().tables);
      return { plan, decisions };
    },
    async reset() {
      try {
        await controller.undo();
      } catch {
        /* nothing applied */
      }
      await dropAllTables(db);
      stitchStore.reset();
      intake.reset();
    },
    dispose: () => duck.dispose(),
  };
}

/** The full stitched result as sorted JSON rows, for equality checks. */
export async function resultSnapshot(
  db: DuckDBService,
  tableName: string
): Promise<{ columns: string[]; rows: string[] }> {
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName.replace(/'/g, "''")}' ORDER BY ordinal_position`
  );
  const columns = cols.map((c) => c.column_name);
  const raw = await db.query<Record<string, unknown>>(
    `SELECT ${columns.map((c) => `CAST("${c.replace(/"/g, '""')}" AS VARCHAR) AS "${c.replace(/"/g, '""')}"`).join(", ")} FROM "${tableName.replace(/"/g, '""')}"`
  );
  const rows = raw.map((r) => JSON.stringify(columns.map((c) => r[c] ?? null))).sort();
  return { columns, rows };
}
