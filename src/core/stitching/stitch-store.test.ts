/**
 * Unit tests for the session-only {@link StitchStore} (Feature 2, task 9).
 *
 * Pure, no DuckDB: verifies the store's snapshot immutability, the subscribe/
 * notify contract, and each mutator's effect — in particular that storing a
 * fresh {@link ProposalSet} drops stale decisions/plan (Req 3.8), that the
 * recomputed flag round-trips, and that undo/clear/reset behave as the
 * controller relies on.
 */

import { describe, expect, it, vi } from "vitest";
import { StitchStore } from "./stitch-store";
import type {
  ApprovalDecision,
  MatchProposal,
  ProposalSet,
  StitchPlan,
  StitchedTable,
  UndoStep,
} from "./types";

function proposalSet(aiUsed = false): ProposalSet {
  const match: MatchProposal = {
    id: "match:a.x=b.y",
    left: { tableName: "a", columnName: "x", type: "string" },
    right: { tableName: "b", columnName: "y", type: "string" },
    confidence: 0.8,
    reason: "test",
    source: "rules",
    components: { nameSim: 0.8, typeCompat: 1, valueOverlap: 0.6 },
  };
  return { matches: [match], cleanings: [], aiUsed };
}

function decision(proposalId: string): ApprovalDecision {
  return { proposalId, decision: "approved" };
}

const plan: StitchPlan = {
  anchorTableName: "a",
  joinKeysByPair: {},
  approvedMatches: [],
  approvedCleanings: [],
};

const stitched: StitchedTable = {
  loadId: 0,
  tableName: "stitch_1_result",
  sourceFileName: "stitch_1_result",
  schema: [{ name: "x", type: "string" }],
  rowCount: 3,
};

const undoStep: UndoStep = { createdTableNames: ["stitch_1_result"] };

describe("StitchStore", () => {
  it("starts empty", () => {
    const store = new StitchStore();
    const s = store.getState();
    expect(s.datasetVersion).toBeNull();
    expect(s.proposals).toBeNull();
    expect(s.decisions).toEqual({});
    expect(s.plan).toBeNull();
    expect(s.stitchedTable).toBeNull();
    expect(s.pendingUndo).toBeNull();
    expect(s.recomputed).toBe(false);
  });

  it("returns a stable snapshot reference until a mutation", () => {
    const store = new StitchStore();
    const first = store.getState();
    expect(store.getState()).toBe(first);
    store.setProposals(proposalSet(), "1,2", false);
    expect(store.getState()).not.toBe(first);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const store = new StitchStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setProposals(proposalSet(), "1", false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.setDecision(decision("match:a.x=b.y"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stores proposals with the dataset version and recomputed flag", () => {
    const store = new StitchStore();
    const set = proposalSet(true);
    store.setProposals(set, "1,2,3", true);
    const s = store.getState();
    expect(s.proposals).toBe(set);
    expect(s.datasetVersion).toBe("1,2,3");
    expect(s.recomputed).toBe(true);
    expect(store.getDatasetVersion()).toBe("1,2,3");
  });

  it("discards stale decisions and plan when new proposals are stored (Req 3.8)", () => {
    const store = new StitchStore();
    store.setProposals(proposalSet(), "1", false);
    store.setDecision(decision("match:a.x=b.y"));
    store.setPlan(plan);
    expect(store.getState().decisions).not.toEqual({});
    expect(store.getState().plan).not.toBeNull();

    // A new ProposalSet (recompute) wipes decisions + plan.
    store.setProposals(proposalSet(), "2", true);
    expect(store.getState().decisions).toEqual({});
    expect(store.getState().plan).toBeNull();
    expect(store.getState().recomputed).toBe(true);
  });

  it("records and reads per-proposal decisions", () => {
    const store = new StitchStore();
    store.setDecision(decision("p1"));
    store.setDecision({ proposalId: "p2", decision: "rejected" });
    expect(store.getDecision("p1")?.decision).toBe("approved");
    expect(store.getDecision("p2")?.decision).toBe("rejected");
    expect(store.getDecision("nope")).toBeUndefined();

    // Re-deciding replaces.
    store.setDecision({ proposalId: "p1", decision: "rejected" });
    expect(store.getDecision("p1")?.decision).toBe("rejected");
  });

  it("records an apply then clears it on undo, keeping proposals intact", () => {
    const store = new StitchStore();
    const set = proposalSet();
    store.setProposals(set, "1", false);
    store.setApplied(stitched, undoStep);
    expect(store.getState().stitchedTable).toBe(stitched);
    expect(store.getState().pendingUndo).toBe(undoStep);

    store.clearApplied();
    expect(store.getState().stitchedTable).toBeNull();
    expect(store.getState().pendingUndo).toBeNull();
    // Proposals survive an undo so the user can re-apply.
    expect(store.getState().proposals).toBe(set);
  });

  it("clears the recomputed flag on acknowledgement", () => {
    const store = new StitchStore();
    store.setProposals(proposalSet(), "1", true);
    expect(store.getState().recomputed).toBe(true);
    store.clearRecomputed();
    expect(store.getState().recomputed).toBe(false);
    // Idempotent when already false (no new snapshot).
    const before = store.getState();
    store.clearRecomputed();
    expect(store.getState()).toBe(before);
  });

  it("discardProposals clears proposals/decisions/plan but not applied state", () => {
    const store = new StitchStore();
    store.setProposals(proposalSet(), "1", false);
    store.setDecision(decision("match:a.x=b.y"));
    store.setApplied(stitched, undoStep);

    store.discardProposals();
    const s = store.getState();
    expect(s.proposals).toBeNull();
    expect(s.decisions).toEqual({});
    expect(s.plan).toBeNull();
    // Applied state is untouched by a proposal discard.
    expect(s.stitchedTable).toBe(stitched);
    expect(s.pendingUndo).toBe(undoStep);
  });

  it("reset returns to the empty state", () => {
    const store = new StitchStore();
    store.setProposals(proposalSet(), "1", true);
    store.setApplied(stitched, undoStep);
    store.reset();
    const s = store.getState();
    expect(s.datasetVersion).toBeNull();
    expect(s.proposals).toBeNull();
    expect(s.stitchedTable).toBeNull();
    expect(s.pendingUndo).toBeNull();
    expect(s.recomputed).toBe(false);
  });
});
