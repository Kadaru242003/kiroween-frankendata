/**
 * ApprovalScreen — the mad-scientist "stitching table" (Feature 2, task 13;
 * design "UI Layer / ApprovalScreen", Req 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 6.8).
 *
 * Lists every displayable {@link MatchProposal} (the controller has already
 * filtered to ≥ `MATCH_DISPLAY_THRESHOLD`) and every {@link CleaningProposal} as
 * a before/after diff (Req 3.1), each with per-proposal approve / reject / edit
 * controls (Req 3.2) and a per-proposal engine badge (Req 6.8). A single
 * "Approve all high-confidence" button approves exactly the matches at or above
 * {@link HIGH_CONFIDENCE_THRESHOLD} (Req 3.3). The {@link StitchPlan} is
 * assembled from the current decisions **only when the user confirms** (Req
 * 3.5) via {@link assembleStitchPlan}, then handed to `onConfirm`.
 *
 * ## State ownership
 *
 * Decisions live in the injected {@link StitchStore} (set via `setDecision`), so
 * this screen is a thin reactive view: it reads `proposals` + `decisions` from
 * the store through {@link useStitchStore} and writes decisions back through the
 * store's mutators. Editing is expressed as an `edited` {@link ApprovalDecision}
 * carrying a `Partial` override — a re-paired match (Req 3.6) or a changed
 * category canonical (Req 3.7).
 *
 * ## Confirm seam (task 14)
 *
 * This task assembles the plan and exposes a confirm handler seam; actually
 * applying the plan (cleaned copies + join + preview) is task 14. `onConfirm`
 * receives the assembled {@link StitchPlan}; the default App wiring stores it on
 * the controller's `applyPlan` seam later. Nothing is applied to DuckDB here.
 *
 * ## Security — plain text only (Req 6.8)
 *
 * Every proposal/AI string is rendered by {@link MatchDiff}/{@link CleaningDiff}
 * as a React text node; this screen adds no `dangerouslySetInnerHTML`.
 */

import { useCallback, useMemo, type JSX } from "react";
import type { ColumnSchema } from "../../core/types";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  type ApprovalDecision,
  type CleaningProposal,
  type DecisionKind,
  type MatchProposal,
  type StitchPlan,
} from "../../core/stitching/types";
import {
  useStitchStore,
  type StitchStore,
} from "../../core/stitching/stitch-store";
import {
  assembleStitchPlan,
  selectHighConfidenceProposalIds,
  type LoadedTableLike,
} from "../../core/stitching/plan-assembly";
import { MatchDiff, type MatchDiffTable } from "./MatchDiff";
import { CleaningDiff } from "./CleaningDiff";
import "./ApprovalScreen.css";

/** Stable empty arrays so a null proposal set doesn't churn referential identity. */
const EMPTY_MATCHES: readonly MatchProposal[] = [];
const EMPTY_CLEANINGS: readonly CleaningProposal[] = [];

/** A loaded table descriptor the screen needs for re-pair targets + anchoring. */
export interface ApprovalScreenTable extends LoadedTableLike, MatchDiffTable {
  tableName: string;
  rowCount: number;
  schema: ColumnSchema[];
}

/** Props for {@link ApprovalScreen}. */
export interface ApprovalScreenProps {
  /** The session store holding proposals + decisions (read + written here). */
  store: StitchStore;
  /** The currently loaded tables (for re-pair targets and the default anchor). */
  tables: readonly ApprovalScreenTable[];
  /**
   * Called when the user confirms, with the assembled {@link StitchPlan} (Req
   * 3.5). Apply wiring is task 14; here we only build and surface the plan.
   */
  onConfirm: (plan: StitchPlan) => void;
}

/**
 * The approval screen. Reactive over the injected store; records decisions and
 * assembles the plan on confirm.
 */
export function ApprovalScreen({
  store,
  tables,
  onConfirm,
}: ApprovalScreenProps): JSX.Element {
  const state = useStitchStore(store);
  const { proposals, decisions } = state;

  // Memoize so the arrays keep a stable reference across renders (the store
  // snapshot only changes on a real mutation). This keeps the callbacks/memo
  // below from being recreated every render.
  const matches: readonly MatchProposal[] = useMemo(
    () => proposals?.matches ?? EMPTY_MATCHES,
    [proposals]
  );
  const cleanings: readonly CleaningProposal[] = useMemo(
    () => proposals?.cleanings ?? EMPTY_CLEANINGS,
    [proposals]
  );

  /** The current decision kind for a proposal id, or `undefined`. */
  const decisionFor = useCallback(
    (id: string): DecisionKind | undefined => decisions[id]?.decision,
    [decisions]
  );

  const approve = useCallback(
    (proposalId: string) => {
      store.setDecision({ proposalId, decision: "approved" });
    },
    [store]
  );

  const reject = useCallback(
    (proposalId: string) => {
      store.setDecision({ proposalId, decision: "rejected" });
    },
    [store]
  );

  /**
   * Re-pair a match to a different `right` column in the same right-hand table
   * (Req 3.6). Records an `edited` decision whose `edit` overrides `right` — and
   * re-derives the pair `id` so the edited proposal stays internally coherent.
   */
  const repairMatch = useCallback(
    (proposalId: string, nextRightColumnName: string) => {
      const base = matches.find((m) => m.id === proposalId);
      if (!base) {
        return;
      }
      const rightTable = tables.find(
        (t) => t.tableName === base.right.tableName
      );
      const nextCol = rightTable?.schema.find(
        (c) => c.name === nextRightColumnName
      );
      if (!nextCol) {
        return;
      }
      const edit: Partial<MatchProposal> = {
        right: {
          tableName: base.right.tableName,
          columnName: nextCol.name,
          type: nextCol.type,
        },
        id: `${base.left.tableName}.${base.left.columnName}~${base.right.tableName}.${nextCol.name}`,
      };
      const decision: ApprovalDecision = {
        proposalId,
        decision: "edited",
        edit,
      };
      store.setDecision(decision);
    },
    [matches, tables, store]
  );

  /**
   * Change the canonical value of a category-standardize cleaning (Req 3.7).
   * Records an `edited` decision overriding `canonical`.
   */
  const editCanonical = useCallback(
    (proposalId: string, nextCanonical: string) => {
      const edit: Partial<CleaningProposal> = { canonical: nextCanonical };
      store.setDecision({ proposalId, decision: "edited", edit });
    },
    [store]
  );

  /**
   * "Approve all high-confidence": approve exactly the matches whose confidence
   * is ≥ {@link HIGH_CONFIDENCE_THRESHOLD}, and no others (Req 3.3). Existing
   * decisions on below-threshold matches are left untouched.
   */
  const approveAllHighConfidence = useCallback(() => {
    for (const proposalId of selectHighConfidenceProposalIds(
      matches,
      HIGH_CONFIDENCE_THRESHOLD
    )) {
      store.setDecision({ proposalId, decision: "approved" });
    }
  }, [matches, store]);

  /**
   * "Approve all suggestions": approve every PENDING (undecided) match and
   * cleanup proposal. Proposals the user has already decided — including ones
   * they REJECTED, and ones they approved or edited — are left untouched, so
   * this never overrides an explicit reject. Per-card controls keep working.
   */
  const approveAllSuggestions = useCallback(() => {
    for (const proposal of [...matches, ...cleanings]) {
      if (decisions[proposal.id] === undefined) {
        store.setDecision({ proposalId: proposal.id, decision: "approved" });
      }
    }
  }, [matches, cleanings, decisions, store]);

  /**
   * Assemble the plan from the current decisions and hand it to `onConfirm`
   * (Req 3.5). This is the explicit confirm action — nothing is assembled until
   * the user clicks. The assembled plan is also stored so later apply wiring
   * (task 14) can read it back.
   */
  const confirm = useCallback(() => {
    if (!proposals) {
      return;
    }
    const plan = assembleStitchPlan(proposals, decisions, tables);
    store.setPlan(plan);
    onConfirm(plan);
  }, [proposals, decisions, tables, store, onConfirm]);

  const hasHighConfidence = useMemo(
    () => matches.some((m) => m.confidence >= HIGH_CONFIDENCE_THRESHOLD),
    [matches]
  );

  const hasAnyProposal = matches.length > 0 || cleanings.length > 0;

  return (
    <section className="approval-screen" aria-label="Stitching table">
      <header className="approval-screen__header">
        <h2 className="approval-screen__title">Stitching table</h2>
        <p className="approval-screen__subtitle">
          Review each proposed match and cleanup. Nothing is applied until you
          confirm.
        </p>
        {state.recomputed ? (
          <p className="approval-screen__notice" role="status">
            Proposals recomputed because the loaded tables changed.
          </p>
        ) : null}
      </header>

      <div className="approval-screen__toolbar">
        <button
          type="button"
          className="approval-screen__bulk"
          onClick={approveAllHighConfidence}
          disabled={!hasHighConfidence}
        >
          Approve all high-confidence
        </button>
        <button
          type="button"
          className="approval-screen__bulk"
          onClick={approveAllSuggestions}
          disabled={!hasAnyProposal}
        >
          Approve all suggestions
        </button>
        <button
          type="button"
          className="approval-screen__confirm"
          onClick={confirm}
          disabled={!hasAnyProposal}
        >
          Confirm &amp; stitch
        </button>
      </div>

      {!hasAnyProposal ? (
        <p className="approval-screen__empty">
          No proposals yet. Load two or more tables to see matches and cleanups.
        </p>
      ) : null}

      {matches.length > 0 ? (
        <div className="approval-screen__group" aria-label="Column matches">
          <h3 className="approval-screen__group-title">Column matches</h3>
          <div className="approval-screen__list">
            {matches.map((proposal) => (
              <MatchDiff
                key={proposal.id}
                proposal={proposal}
                decision={decisionFor(proposal.id)}
                tables={tables}
                onApprove={approve}
                onReject={reject}
                onRepair={repairMatch}
              />
            ))}
          </div>
        </div>
      ) : null}

      {cleanings.length > 0 ? (
        <div className="approval-screen__group" aria-label="Cleanups">
          <h3 className="approval-screen__group-title">Cleanups</h3>
          <div className="approval-screen__list">
            {cleanings.map((proposal) => (
              <CleaningDiff
                key={proposal.id}
                proposal={proposal}
                decision={decisionFor(proposal.id)}
                onApprove={approve}
                onReject={reject}
                onEditCanonical={editCanonical}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default ApprovalScreen;
