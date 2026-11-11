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
import { budgetAiRequest, isAiEnabled } from "./ai-budget";
import { validateAiResponse } from "./ai-validation";
import {
  MATCH_DISPLAY_THRESHOLD,
  type AiProvider,
  type MatchProposal,
  type ProposalSet,
  type RulesEngine,
  type StitchController,
  type StitchPlan,
  type StitchedTable,
  type TableSample,
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
   * Optional AI provider (task 19). When absent, the controller runs rules-only
   * and never attempts a network call; the resulting {@link ProposalSet} has
   * `aiUsed = false`. When present, the controller budgets a request from the
   * rules matches, calls `refine`, validates the response, and merges bounded
   * refinements — but any failure/absence/over-budget falls back to the exact
   * rules result (`aiUsed = false`), so the app never depends on the AI.
   */
  aiProvider?: AiProvider;
  /**
   * The `VITE_AI_ENABLED` build-time flag value (design: "Dev-mode behavior and
   * feature flag"). AI is attempted ONLY when this is the string `"true"` AND an
   * {@link aiProvider} is injected; otherwise the controller runs rules-only
   * with no network attempt. Injected for testability — production passes
   * `import.meta.env.VITE_AI_ENABLED`.
   */
  aiEnabledFlag?: unknown;
  /**
   * Optional table-selection filter (polish batch 2, item 1). When provided,
   * `computeProposals` proposes matches/cleanups over ONLY the tables for which
   * this returns `true` — so with more than two tables loaded the user can
   * exclude tables (and avoid a table being matched against another copy of
   * itself). When omitted, every loaded table participates (the original
   * behavior). The `datasetVersion` is derived from the FILTERED set, so
   * toggling a table correctly invalidates stale proposals (Req 3.8).
   */
  selectTable?: (table: LoadedTable) => boolean;
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
  const aiEnabledFlag = options.aiEnabledFlag;
  const selectTable = options.selectTable;

  /**
   * Optionally refine the rules matches via the injected {@link AiProvider}
   * (design: "Client request payload budgeting", "Response validation steps",
   * guaranteed rules fallback). Returns the (possibly) refined, display-ordered
   * matches plus whether the AI was actually used.
   *
   * Every exit except a fully-successful, validated refinement returns the
   * ORIGINAL rules matches unchanged with `aiUsed = false`:
   *   - AI disabled (`VITE_AI_ENABLED` not `"true"`) or no provider injected;
   *   - budgeting decides there are no candidates or the body is over the byte
   *     budget (skips the call silently);
   *   - `refine` throws/rejects/times out, or returns an unparseable/mis-shaped
   *     body;
   *   - validation drops every refinement.
   *
   * On success, the validated refinements are merged into the sent matches
   * (bounded ±0.2 confidence, truncated reason, `source = "ai"`); any match the
   * AI demoted below {@link MATCH_DISPLAY_THRESHOLD} is hidden, and non-candidate
   * rules matches (none, since all display matches are sent) are preserved. The
   * result is re-sorted into the deterministic display order.
   */
  async function refineMatches(
    matches: MatchProposal[],
    samples: TableSample[]
  ): Promise<{ matches: MatchProposal[]; aiUsed: boolean }> {
    // Kill switch + absence: no provider or flag off → rules-only, no network.
    if (!aiProvider || !isAiEnabled(aiEnabledFlag)) {
      return { matches, aiUsed: false };
    }

    // Budget the request. A "skip" (no candidates / over byte budget) mirrors
    // the normal fallback path: use the rules result, no error, no call.
    const budget = budgetAiRequest(matches, samples);
    if (budget.skip) {
      return { matches, aiUsed: false };
    }

    // The exact matches sent as candidates (same id set the request carries),
    // so validation's eligibility check lines up with what the AI saw.
    const sentIds = new Set(budget.request.candidates.map((c) => c.id));
    const sentMatches = matches.filter((m) => sentIds.has(m.id));

    // Guaranteed rules fallback (Req 6.5, 6.6): any failure of refine() —
    // throw, reject, timeout (abort), non-200, or non-JSON body — is swallowed
    // and the deterministic result is used unchanged.
    let body: unknown;
    try {
      body = await aiProvider.refine(budget.request);
    } catch {
      return { matches, aiUsed: false };
    }

    // Validate + merge. A total-shape failure or all-dropped refinements yields
    // aiUsed = false and the rules matches unchanged.
    const { matches: merged, aiUsed } = validateAiResponse(body, sentMatches);
    if (!aiUsed) {
      return { matches, aiUsed: false };
    }

    // Re-assemble the display set: the AI can demote a visible match below the
    // display threshold (hiding it) but never resurrect a hidden one (none were
    // sent). Keep merged candidates >= threshold; every display match was sent,
    // so there are no non-candidate matches to carry. Re-sort deterministically.
    const refined = merged.filter((m) => m.confidence >= MATCH_DISPLAY_THRESHOLD);
    refined.sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return { matches: refined, aiUsed: true };
  }

  /**
   * Read samples, run the rules engine (match + clean), optionally refine via
   * the injected {@link AiProvider} (with a guaranteed rules fallback), and
   * store the resulting {@link ProposalSet}. On a dataset-set change since the
   * last compute, the stored proposals/decisions are discarded first and the
   * store is flagged `recomputed` (Req 3.8).
   */
  async function computeProposals(): Promise<ProposalSet> {
    const allTables = getTables();
    // Only the selected tables participate (item 1). The datasetVersion is
    // derived from this filtered set, so unchecking a table changes the version
    // and correctly recomputes/invalidates (Req 3.8).
    const tables = selectTable
      ? allTables.filter((t) => selectTable(t))
      : allTables;
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
    const rulesMatches = rulesEngine.match(samples);
    const cleanings = await rulesEngine.clean(samples);

    // Optional AI refinement with a guaranteed rules fallback (Req 6.5, 6.6).
    // `refineMatches` never throws: any absence/failure/over-budget returns the
    // rules matches unchanged with aiUsed = false.
    const { matches, aiUsed } = await refineMatches(rulesMatches, samples);

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
