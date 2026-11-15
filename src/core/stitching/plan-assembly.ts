/**
 * Plan assembly — pure helpers that turn the current {@link ProposalSet} and the
 * user's {@link ApprovalDecision}s into a {@link StitchPlan} (Feature 2, task
 * 13; design "StitchPlan (approved + edited proposals, anchor table, per-pair
 * join keys)").
 *
 * The {@link ApprovalScreen} records per-proposal decisions in the
 * {@link import("./stitch-store").StitchStore}; on an explicit confirm it calls
 * {@link assembleStitchPlan} to build the plan that
 * {@link import("./stitch-controller").StitchController.applyPlan} consumes.
 * Keeping this framework-agnostic (no React) lets it be unit-tested directly and
 * keeps the UI component thin.
 *
 * Semantics (design "UI Layer / edit semantics"):
 *   - A match/cleaning is included in the plan only when its decision is
 *     `approved` or `edited` (a `rejected` or undecided proposal is dropped).
 *   - An `edited` decision carries a `Partial` override in
 *     {@link ApprovalDecision.edit}; the override is merged over the base
 *     proposal so an edited match re-pairs to a different column (Req 3.6) and
 *     an edited category proposal uses the changed canonical value (Req 3.7).
 *   - The per-pair join key defaults to the most key-like approved match for
 *     each unordered table pair (see key-stats.ts: a key that is unique on a
 *     side beats a low-cardinality column of higher confidence). Without column
 *     stats it is the highest-confidence match (Req 7.4). JoinControls can pick
 *     a different approved match, so explicit `joinKeysByPair` entries are honored.
 *   - The anchor table defaults to the "many" side of the chosen key (the table
 *     where the key repeats while it is unique on the other side), so the join
 *     is many-to-one and the result has the anchor's row count. When no chosen
 *     key tells the sides apart it is the loaded table with the most rows (Req
 *     7.2). An explicit `anchorTableName` override is honored when supplied.
 *
 * None of this applies anything to DuckDB — it only produces the plan object.
 * Apply happens later, only on confirm, via the controller/applier.
 */

import { chooseDefaultMatch, manySideOf } from "./key-stats";
import { HIGH_CONFIDENCE_THRESHOLD } from "./types";
import type {
  ApprovalDecision,
  CleaningProposal,
  ColumnKeyStats,
  MatchProposal,
  ProposalSet,
  StitchPlan,
} from "./types";

/**
 * The minimal shape of a loaded table the anchor default needs: a name and a
 * row count. {@link import("../types").LoadedTable} satisfies it.
 */
export interface LoadedTableLike {
  tableName: string;
  rowCount: number;
}

/** Merge an `edited` decision's partial override onto a match proposal. */
function applyMatchEdit(
  base: MatchProposal,
  edit: ApprovalDecision["edit"]
): MatchProposal {
  if (!edit) {
    return base;
  }
  // The edit is a Partial<MatchProposal> | Partial<CleaningProposal>; only
  // match-shaped keys are relevant here. Spreading is safe because unrelated
  // cleaning keys are simply ignored by the MatchProposal type.
  return { ...base, ...(edit as Partial<MatchProposal>) };
}

/** Merge an `edited` decision's partial override onto a cleaning proposal. */
function applyCleaningEdit(
  base: CleaningProposal,
  edit: ApprovalDecision["edit"]
): CleaningProposal {
  if (!edit) {
    return base;
  }
  return { ...base, ...(edit as Partial<CleaningProposal>) };
}

/** `true` when a decision means the proposal is part of the plan. */
function isIncluded(decision: ApprovalDecision | undefined): boolean {
  return decision?.decision === "approved" || decision?.decision === "edited";
}

/**
 * The minimal shape {@link selectHighConfidenceProposalIds} needs from a match:
 * a stable `id` and its `confidence` score. {@link MatchProposal} satisfies it.
 */
export interface ScoredProposalLike {
  id: string;
  confidence: number;
}

/**
 * The pure selection behind the "approve all high-confidence" action (Req 3.3;
 * design "UI Layer / ApprovalScreen" and Property 10). Returns the ids of
 * exactly the proposals whose `confidence` is at or above `threshold` — the
 * boundary is inclusive (`>=`), so a proposal sitting exactly at the threshold
 * is selected — and no others.
 *
 * Keeping this framework-agnostic lets Property 10 prove the selection without
 * rendering React; {@link import("../../components/stitching/ApprovalScreen").ApprovalScreen}
 * calls it to drive the bulk-approve button so the UI behavior and the tested
 * logic are one and the same.
 *
 * `threshold` defaults to {@link HIGH_CONFIDENCE_THRESHOLD}, the constant the UI
 * uses. The result preserves input order and never contains duplicates beyond
 * whatever ids the input already carries.
 */
export function selectHighConfidenceProposalIds(
  proposals: readonly ScoredProposalLike[],
  threshold: number = HIGH_CONFIDENCE_THRESHOLD
): string[] {
  const ids: string[] = [];
  for (const proposal of proposals) {
    if (proposal.confidence >= threshold) {
      ids.push(proposal.id);
    }
  }
  return ids;
}

/**
 * The stable unordered-pair key for a match's two tables, used as the
 * {@link StitchPlan.joinKeysByPair} key (design: `"tableA|tableB"`). Sorting the
 * two names makes the key independent of match direction.
 */
export function pairKey(tableA: string, tableB: string): string {
  return [tableA, tableB].sort().join("|");
}

/**
 * Choose the default anchor table: the one with the most rows among the loaded
 * tables (Req 7.2). Ties break on `tableName` ascending for determinism. Returns
 * `undefined` when there are no tables.
 */
export function defaultAnchorTableName(
  tables: readonly LoadedTableLike[]
): string | undefined {
  let best: LoadedTableLike | undefined;
  for (const t of tables) {
    if (
      best === undefined ||
      t.rowCount > best.rowCount ||
      (t.rowCount === best.rowCount && t.tableName < best.tableName)
    ) {
      best = t;
    }
  }
  return best?.tableName;
}

/**
 * Build the default per-pair join-key map: for each unordered table pair that
 * has at least one approved/edited match, pick the most key-like such match
 * (see {@link chooseDefaultMatch}) and map the pair key to that match's `id`
 * (Req 7.4). With no `stats` this is the highest-confidence match, ties on
 * `id` ascending.
 */
export function defaultJoinKeysByPair(
  approvedMatches: readonly MatchProposal[],
  stats?: Readonly<Record<string, ColumnKeyStats>>
): Record<string, string> {
  const byPair = new Map<string, MatchProposal[]>();
  for (const m of approvedMatches) {
    const key = pairKey(m.left.tableName, m.right.tableName);
    const bucket = byPair.get(key);
    if (bucket) bucket.push(m);
    else byPair.set(key, [m]);
  }
  const result: Record<string, string> = {};
  for (const [key, matches] of byPair) {
    const chosen = chooseDefaultMatch(matches, stats);
    if (chosen) result[key] = chosen.id;
  }
  return result;
}

/**
 * The default anchor given the chosen join keys: the table that most keys
 * identify as the "many" side (key repeats there, unique on the other side).
 * Ties, and the case with no such key, fall back to
 * {@link defaultAnchorTableName} among the tied (or all) tables.
 */
export function defaultAnchorForKeys(
  tables: readonly LoadedTableLike[],
  chosenMatches: readonly MatchProposal[],
  stats: Readonly<Record<string, ColumnKeyStats>> | undefined
): string | undefined {
  const votes = new Map<string, number>();
  for (const m of chosenMatches) {
    const many = manySideOf(m, stats);
    if (many !== undefined) votes.set(many, (votes.get(many) ?? 0) + 1);
  }
  const loaded = tables.filter((t) => votes.has(t.tableName));
  if (loaded.length === 0) return defaultAnchorTableName(tables);
  const top = Math.max(...loaded.map((t) => votes.get(t.tableName) ?? 0));
  return defaultAnchorTableName(
    loaded.filter((t) => (votes.get(t.tableName) ?? 0) === top)
  );
}

/** Overrides the UI may supply when assembling the plan (task 14 wiring). */
export interface AssembleOptions {
  /** Explicit anchor table name (defaults to the most-rows table, Req 7.2). */
  anchorTableName?: string;
  /**
   * Explicit per-pair join-key overrides, merged over the computed defaults so
   * JoinControls can pick a different approved match per pair (Req 7.4).
   */
  joinKeysByPair?: Record<string, string>;
}

/**
 * Assemble a {@link StitchPlan} from the current proposals and decisions (design
 * "StitchPlan"). Only `approved`/`edited` proposals are included; `edited` ones
 * have their decision override merged in (re-paired match / changed canonical).
 * The anchor and per-pair join keys use the Req 7.2 / 7.4 defaults unless
 * explicitly overridden via `options`.
 *
 * This is a pure function — it assembles the plan object only and applies
 * nothing to DuckDB.
 */
export function assembleStitchPlan(
  proposals: ProposalSet,
  decisions: Readonly<Record<string, ApprovalDecision>>,
  tables: readonly LoadedTableLike[],
  options: AssembleOptions = {}
): StitchPlan {
  const approvedMatches: MatchProposal[] = [];
  for (const match of proposals.matches) {
    const decision = decisions[match.id];
    if (isIncluded(decision)) {
      approvedMatches.push(applyMatchEdit(match, decision?.edit));
    }
  }

  const approvedCleanings: CleaningProposal[] = [];
  for (const cleaning of proposals.cleanings) {
    const decision = decisions[cleaning.id];
    if (isIncluded(decision)) {
      approvedCleanings.push(applyCleaningEdit(cleaning, decision?.edit));
    }
  }

  const stats = proposals.columnStats;
  const joinKeysByPair = {
    ...defaultJoinKeysByPair(approvedMatches, stats),
    ...(options.joinKeysByPair ?? {}),
  };

  // The anchor follows the keys actually in the plan (defaults plus overrides).
  const chosenMatches = approvedMatches.filter((m) =>
    Object.values(joinKeysByPair).includes(m.id)
  );
  const anchorTableName =
    options.anchorTableName ??
    defaultAnchorForKeys(tables, chosenMatches, stats) ??
    "";

  return {
    anchorTableName,
    joinKeysByPair,
    approvedMatches,
    approvedCleanings,
  };
}
