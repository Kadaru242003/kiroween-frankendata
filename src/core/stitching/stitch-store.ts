/**
 * StitchStore — session-only state for the stitching stage (Feature 2, task 9).
 *
 * Mirrors the design "Session State / StitchStore": a small, framework-agnostic
 * holder for everything the stitching UI reads and the {@link StitchController}
 * writes, for the current browser session only. There is NO persistence —
 * nothing is written to `localStorage`, `IndexedDB`, or any backing store; a
 * page refresh recreates an empty store (and a fresh DuckDB), exactly the
 * ephemeral behavior Feature 1's {@link import("../../state/intake-store").IntakeStore}
 * uses (Req 4.4, 5.1, 5.4).
 *
 * It holds (design: "StitchStore"):
 *   - the current {@link ProposalSet} (matches ≥ display threshold + cleanings);
 *   - the user's {@link ApprovalDecision}s, keyed by proposal id;
 *   - the active {@link StitchPlan} assembled on confirm;
 *   - the created {@link StitchedTable} descriptor;
 *   - the pending {@link UndoStep};
 *   - the {@link StitchState.datasetVersion} the controller derives from the
 *     sorted `loadId`s, and a {@link StitchState.recomputed} flag the UI reads
 *     to show the "proposals recomputed" notice after a dataset change (Req
 *     3.8).
 *
 * Like the intake store it is a tiny observable (`getState` / `subscribe`) so a
 * React layer can subscribe via `useSyncExternalStore`, but the store itself
 * has no React dependency so the controller and its tests use it headlessly.
 */

import type {
  ApprovalDecision,
  ProposalSet,
  StitchPlan,
  StitchedTable,
  UndoStep,
} from "./types";

/** Immutable snapshot of the stitch store's state handed to subscribers. */
export interface StitchState {
  /**
   * A signature of the current loaded-table set, derived by the controller from
   * the sorted list of `loadId`s (see the design "ProposalSet lifecycle and
   * staleness"). `null` before any compute. When it changes, the controller
   * discards proposals + decisions and recomputes (Req 3.8).
   */
  readonly datasetVersion: string | null;
  /**
   * The current proposals surfaced to the UI (matches already filtered to ≥
   * `MATCH_DISPLAY_THRESHOLD`), or `null` before the first compute / after a
   * discard.
   */
  readonly proposals: ProposalSet | null;
  /** The user's decisions, keyed by proposal id (empty before any decision). */
  readonly decisions: Readonly<Record<string, ApprovalDecision>>;
  /** The plan assembled on confirm, or `null` before apply. */
  readonly plan: StitchPlan | null;
  /** The created stitched-table descriptor, or `null` before apply / after undo. */
  readonly stitchedTable: StitchedTable | null;
  /** The pending undo step, or `null` when there is nothing to undo. */
  readonly pendingUndo: UndoStep | null;
  /**
   * `true` immediately after the controller discarded and recomputed proposals
   * because the loaded-table set changed, so the UI can show a "proposals
   * recomputed" notice (Req 3.8). The UI acknowledges it via
   * {@link StitchStore.clearRecomputed} once shown.
   */
  readonly recomputed: boolean;
}

/** A subscriber notified whenever the state changes. */
type Listener = () => void;

/** An empty snapshot: the initial state and the result of a full reset. */
const EMPTY_STATE: StitchState = Object.freeze({
  datasetVersion: null,
  proposals: null,
  decisions: Object.freeze({}) as Readonly<Record<string, ApprovalDecision>>,
  plan: null,
  stitchedTable: null,
  pendingUndo: null,
  recomputed: false,
});

/**
 * A session-only, in-memory observable store of the stitching stage's state.
 *
 * State is a single immutable {@link StitchState} snapshot; every mutation
 * replaces it with a new frozen object (so referential identity changes exactly
 * when the state changes, which `useSyncExternalStore` relies on) and notifies
 * subscribers. All mutators are deliberately low-level: the
 * {@link StitchController} orchestrates them; the store enforces no workflow
 * policy of its own.
 */
export class StitchStore {
  private state: StitchState = EMPTY_STATE;
  private readonly listeners = new Set<Listener>();

  /** Current immutable snapshot; stable until the next mutation. */
  getState = (): StitchState => this.state;

  /**
   * Subscribe to state changes; returns an unsubscribe function. Bound as an
   * arrow property so it can be passed straight to `useSyncExternalStore`.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current dataset signature (see {@link StitchState.datasetVersion}). */
  getDatasetVersion(): string | null {
    return this.state.datasetVersion;
  }

  /**
   * Store a freshly computed {@link ProposalSet} for `datasetVersion`,
   * discarding any prior decisions, plan, and stitched table (the proposals are
   * new, so stale decisions must not carry over — Req 3.8). `recomputed` records
   * whether this was a recompute triggered by a dataset-set change (so the UI
   * can show the notice) vs. the very first compute.
   */
  setProposals(
    proposals: ProposalSet,
    datasetVersion: string,
    recomputed: boolean
  ): void {
    this.state = Object.freeze({
      ...this.state,
      datasetVersion,
      proposals,
      decisions: Object.freeze({}),
      plan: null,
      recomputed,
    });
    this.emit();
  }

  /** Record (or replace) the user's decision for one proposal (Req 3.2). */
  setDecision(decision: ApprovalDecision): void {
    this.state = Object.freeze({
      ...this.state,
      decisions: Object.freeze({
        ...this.state.decisions,
        [decision.proposalId]: decision,
      }),
    });
    this.emit();
  }

  /** The decision for a proposal, or `undefined` when none has been made. */
  getDecision(proposalId: string): ApprovalDecision | undefined {
    return this.state.decisions[proposalId];
  }

  /** Store the plan assembled on confirm, about to be applied (Req 3.5). */
  setPlan(plan: StitchPlan): void {
    this.state = Object.freeze({ ...this.state, plan });
    this.emit();
  }

  /**
   * Record a successful apply: the created {@link StitchedTable} descriptor and
   * the pending {@link UndoStep} to undo it (Req 4.2, 7.11).
   */
  setApplied(stitchedTable: StitchedTable, pendingUndo: UndoStep): void {
    this.state = Object.freeze({
      ...this.state,
      stitchedTable,
      pendingUndo,
    });
    this.emit();
  }

  /**
   * Clear the applied result after an undo: drop the stitched table descriptor
   * and the pending undo step (Req 4.3). Proposals and decisions are left intact
   * so the user can adjust and re-apply.
   */
  clearApplied(): void {
    this.state = Object.freeze({
      ...this.state,
      stitchedTable: null,
      pendingUndo: null,
    });
    this.emit();
  }

  /**
   * Acknowledge the "proposals recomputed" notice: clear the {@link
   * StitchState.recomputed} flag once the UI has shown it (Req 3.8).
   */
  clearRecomputed(): void {
    if (!this.state.recomputed) {
      return;
    }
    this.state = Object.freeze({ ...this.state, recomputed: false });
    this.emit();
  }

  /**
   * Discard proposals, decisions, plan, and the recomputed flag (NOT the
   * applied/undo state) back to pre-compute. Used by the controller when the
   * loaded-table set changes before a recompute runs (Req 3.8).
   */
  discardProposals(): void {
    this.state = Object.freeze({
      ...this.state,
      proposals: null,
      decisions: Object.freeze({}),
      plan: null,
      recomputed: false,
    });
    this.emit();
  }

  /** Reset the entire store to its empty initial state (fresh session). */
  reset(): void {
    if (this.state === EMPTY_STATE) {
      return;
    }
    this.state = EMPTY_STATE;
    this.emit();
  }

  /** Notify every current subscriber of a state change. */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
