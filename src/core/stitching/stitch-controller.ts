/**
 * StitchController — rules-only orchestration of the stitching stage (Feature
 * 2, task 9). Wires together the already-built, framework-agnostic pieces:
 *
 *   - {@link import("./sample-reader").SampleReader} (task 4) — reads the
 *     deterministic, frequency-carrying per-column samples from DuckDB;
 *   - {@link import("./rules-engine").createRulesEngine} (tasks 6 + 7) — the
 *     deterministic match + clean engine;
 *   - {@link import("./stitch-applier").createStitchApplier} (task 8) —
 *     cleaned-copy + join-chain apply and single-step undo;
 *   - {@link StitchStore} — the session-only state the UI reads.
 *
 * It is pure except for the injected {@link DuckDBService} (reads samples,
 * reads back the stitched table's schema/row count), the {@link SampleReader},
 * the {@link RulesEngine}, the {@link StitchApplier}, and the {@link StitchStore}.
 * No React, DOM, or network (Req 5.1, 5.4).
 *
 * ## AI seam (design: "AiProvider", task 19 will fill it in)
 *
 * `computeProposals` accepts an optional {@link AiProvider}, but this task wires
 * ONLY the rules engine: when no provider is injected (the default), it never
 * attempts any network call and the resulting {@link ProposalSet} carries
 * `aiUsed = false`. Task 19 will inject a real {@link AiProvider} here and add
 * client payload budgeting + response validation; the controller's contract and
 * the guaranteed rules fallback stay unchanged. The injection point exists now
 * so later wiring does not reshape this module.
 *
 * ## Staleness (design: "ProposalSet lifecycle and staleness", Req 3.8)
 *
 * The controller derives a {@link datasetVersion} string from the sorted list
 * of the current tables' `loadId`s. Because Feature 1 assigns a fresh
 * monotonically-increasing `loadId` on every intake, re-dropping an identical
 * file yields a different `loadId` and therefore a different `datasetVersion`,
 * so cached proposals invalidate correctly (a name+rowCount signature would
 * not). Whenever `computeProposals` sees a version different from the store's,
 * it discards the stored {@link ProposalSet} and all {@link ApprovalDecision}s,
 * recomputes, and flags `recomputed` on the store so the UI can show the
 * "proposals recomputed" notice.
 */

import {
  COLUMN_TYPE_TO_DUCKDB_TYPE,
  type ColumnSchema,
  type ColumnType,
  type DuckDBService,
  type LoadedTable,
} from "../types";
import { quoteString } from "./sql-escape";
import {
  createSampleReader,
  toSampleSource,
  type SampleReader,
} from "./sample-reader";
import { createRulesEngine } from "./rules-engine";
import {
  createStitchApplier,
  type StitchApplier,
  type StitchApplyResult,
} from "./stitch-applier";
import type { StitchStore } from "./stitch-store";
import type {
  AiProvider,
  ProposalSet,
  RulesEngine,
  StitchController,
  StitchPlan,
  StitchedTable,
} from "./types";

/** Source of the currently-loaded tables (the intake store's snapshot). */
export type LoadedTablesProvider = () => readonly LoadedTable[];

/** Options for {@link createStitchController}. */
export interface StitchControllerOptions {
  /** Read-only DuckDB access (samples, stitched-table descriptor read-back). */
  db: DuckDBService;
  /** Yields the current loaded tables (e.g. `() => intakeStore.getState().tables`). */
  getTables: LoadedTablesProvider;
  /** Session-only state the controller writes and the UI reads. */
  store: StitchStore;
  /**
   * Optional injected pieces, overridable for tests. When omitted they are
   * constructed from `db` (the production wiring).
   */
  sampleReader?: SampleReader;
  rulesEngine?: RulesEngine;
  applier?: StitchApplier;
  /**
   * Optional AI provider (task 19). When absent — the default for this task —
   * the controller runs rules-only and never attempts a network call; the
   * resulting {@link ProposalSet} has `aiUsed = false`.
   */
  aiProvider?: AiProvider;
}

/**
 * Derive the {@link StitchStore.getDatasetVersion} signature from the current
 * tables: the sorted list of their `loadId`s joined into a stable string. Pure
 * and order-independent (sorting makes table insertion order irrelevant), and
 * sensitive to add / remove / replace because each intake stamps a fresh
 * `loadId` (Req 3.8).
 */
export function computeDatasetVersion(
  tables: readonly LoadedTable[]
): string {
  return tables
    .map((t) => t.loadId)
    .slice()
    .sort((a, b) => a - b)
    .join(",");
}

/**
 * Map a DuckDB `information_schema.columns.data_type` to the Feature-1
 * {@link ColumnType}. The join result's columns come from the cleaned copies /
 * originals, whose DuckDB types are exactly the ones Feature 1's
 * {@link COLUMN_TYPE_TO_DUCKDB_TYPE} produced, so the mapping is the inverse of
 * that table; the extra `is_outlier BOOLEAN` flag maps to `boolean`. Anything
 * unrecognized falls back to `string` (the Feature-1 safe default).
 */
export function duckdbTypeToColumnType(dataType: string): ColumnType {
  const normalized = dataType.trim().toUpperCase();
  switch (normalized) {
    case COLUMN_TYPE_TO_DUCKDB_TYPE.number: // DOUBLE
      return "number";
    case COLUMN_TYPE_TO_DUCKDB_TYPE.boolean: // BOOLEAN
      return "boolean";
    case COLUMN_TYPE_TO_DUCKDB_TYPE.date: // DATE
      return "date";
    case COLUMN_TYPE_TO_DUCKDB_TYPE.string: // VARCHAR
      return "string";
    default:
      return "string";
  }
}

/** One row of the `information_schema.columns` read, used to build the schema. */
interface InfoSchemaRow {
  column_name: string;
  data_type: string;
  ordinal_position: number | bigint;
}

/**
 * Build a {@link StitchedTable} descriptor for a just-created result table from
 * `information_schema.columns` + {@link DuckDBService.getRowCount} (design:
 * "Apply", "Reads use the existing DuckDBService.query; the StitchedTable
 * descriptor is built from information_schema + getRowCount"; Req 7.11). The
 * columns are ordered by `ordinal_position` so they match the stitched table's
 * actual column order. `loadId` is a `0` placeholder — a stitched table is not
 * routed through the intake store's id sequence; the UI reads it from the store
 * descriptor, not by `loadId`.
 */
export async function buildStitchedTableDescriptor(
  db: DuckDBService,
  tableName: string
): Promise<StitchedTable> {
  const rows = await db.query<InfoSchemaRow>(
    `SELECT column_name, data_type, ordinal_position ` +
      `FROM information_schema.columns ` +
      `WHERE table_name = ${quoteString(tableName)} ` +
      `ORDER BY ordinal_position`
  );
  const schema: ColumnSchema[] = rows.map((r) => ({
    name: String(r.column_name),
    type: duckdbTypeToColumnType(String(r.data_type)),
  }));
  const rowCount = await db.getRowCount(tableName);
  return {
    loadId: 0,
    tableName,
    sourceFileName: tableName,
    schema,
    rowCount,
  };
}

/**
 * Create a rules-only {@link StitchController}. See the module doc for the
 * wiring and staleness behavior.
 */
export function createStitchController(
  options: StitchControllerOptions
): StitchController {
  const { db, getTables, store } = options;
  const sampleReader = options.sampleReader ?? createSampleReader(db);
  const rulesEngine = options.rulesEngine ?? createRulesEngine(db);
  const applier = options.applier ?? createStitchApplier(db);
  const aiProvider = options.aiProvider;

  /**
   * Read samples, run the rules engine (match + clean), optionally refine via
   * the injected {@link AiProvider} (no-op in this task — always falls back to
   * the rules result), and store the resulting {@link ProposalSet}. On a
   * dataset-set change since the last compute, the stored proposals/decisions
   * are discarded first and the store is flagged `recomputed` (Req 3.8).
   */
  async function computeProposals(): Promise<ProposalSet> {
    const tables = getTables();
    const datasetVersion = computeDatasetVersion(tables);
    const previousVersion = store.getDatasetVersion();
    // A change since the last stored version means the prior proposals and all
    // decisions are stale and must be discarded before recomputing (Req 3.8).
    // The very first compute (previousVersion === null) is not a "recompute".
    const isRecompute =
      previousVersion !== null && previousVersion !== datasetVersion;
    if (isRecompute) {
      store.discardProposals();
    }

    // Deterministic samples → rules match + clean (tasks 4, 6, 7).
    const samples = await sampleReader.readTables(
      tables.map((t) => toSampleSource(t))
    );
    const matches = rulesEngine.match(samples);
    const cleanings = await rulesEngine.clean(samples);

    // AI refinement seam (task 19). With no provider injected we run rules-only
    // and never touch the network; aiUsed stays false. When a provider IS
    // injected later, any failure/absence must still fall back to this exact
    // rules result — task 19 wraps the refine() call in that guarantee.
    let aiUsed = false;
    if (aiProvider) {
      try {
        // Placeholder seam: task 19 builds the budgeted AiRequest from `matches`
        // + `samples`, calls `aiProvider.refine(...)`, validates the response,
        // and merges bounded refinements into `matches`. Until then there is no
        // request to make, so we leave the rules result unchanged.
        void aiProvider;
        aiUsed = false;
      } catch {
        // Guaranteed rules fallback (Req 6.5, 6.6): any AI failure is swallowed
        // and the deterministic result is used unchanged.
        aiUsed = false;
      }
    }

    const proposals: ProposalSet = { matches, cleanings, aiUsed };
    store.setProposals(proposals, datasetVersion, isRecompute);
    return proposals;
  }

  /**
   * Apply a confirmed {@link StitchPlan}: delegate to the {@link StitchApplier}
   * (cleaned copies + LEFT-JOIN result + undo recording), build the {@link
   * StitchedTable} descriptor from `information_schema` + `getRowCount`, and
   * store both the descriptor and the pending {@link UndoStep} (Req 4.1, 4.2,
   * 7.11). Originals are never touched (the applier only writes `stitch_`-
   * prefixed tables).
   */
  async function applyPlan(plan: StitchPlan): Promise<StitchedTable> {
    const tables = getTables();
    store.setPlan(plan);
    const result: StitchApplyResult = await applier.apply(
      plan,
      tables.slice()
    );
    const stitchedTable = await buildStitchedTableDescriptor(
      db,
      result.resultTableName
    );
    store.setApplied(stitchedTable, result.undoStep, result.fanOut);
    return stitchedTable;
  }

  /**
   * Undo the most recent apply: delegate to the {@link StitchApplier} (drops
   * exactly the created `stitch_` tables, leaving originals untouched) and clear
   * the stitched-table + pending-undo state from the store (Req 4.3). Proposals
   * and decisions are left intact so the user can adjust and re-apply.
   */
  async function undo(): Promise<void> {
    await applier.undo();
    store.clearApplied();
  }

  return { computeProposals, applyPlan, undo };
}
