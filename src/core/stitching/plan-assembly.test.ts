/**
 * Unit tests for the pure plan-assembly helpers (Feature 2, task 13).
 *
 * These assert the design "StitchPlan" rules: only approved/edited proposals are
 * included, edits are merged (re-paired match, changed canonical), the anchor
 * defaults to the most-rows table (Req 7.2), and the per-pair join key defaults
 * to the highest-confidence approved match (Req 7.4).
 */
import { describe, expect, it } from "vitest";
import {
  assembleStitchPlan,
  defaultAnchorTableName,
  defaultJoinKeysByPair,
  pairKey,
  type LoadedTableLike,
} from "./plan-assembly";
import type {
  ApprovalDecision,
  CleaningProposal,
  MatchProposal,
  ProposalSet,
} from "./types";

function makeMatch(overrides: Partial<MatchProposal> = {}): MatchProposal {
  return {
    id: "a.x~b.y",
    left: { tableName: "a", columnName: "x", type: "string" },
    right: { tableName: "b", columnName: "y", type: "string" },
    confidence: 0.7,
    reason: "names + value overlap",
    source: "rules",
    components: { nameSim: 0.8, typeCompat: 1, valueOverlap: 0.5 },
    ...overrides,
  };
}

function makeCategory(
  overrides: Partial<CleaningProposal> = {}
): CleaningProposal {
  return {
    id: "clean-a-color",
    target: { tableName: "a", columnName: "color" },
    kind: "category-standardize",
    before: "RED / red / Red",
    after: "Red",
    reason: "3 variants fold to 1",
    canonical: "Red",
    variantMap: { RED: "Red", red: "Red" },
    ...overrides,
  };
}

const tables: LoadedTableLike[] = [
  { tableName: "a", rowCount: 10 },
  { tableName: "b", rowCount: 25 },
  { tableName: "c", rowCount: 25 },
];

describe("defaultAnchorTableName", () => {
  it("picks the table with the most rows (Req 7.2)", () => {
    expect(defaultAnchorTableName(tables)).toBe("b"); // b,c tie at 25; b < c
  });

  it("returns undefined for an empty table set", () => {
    expect(defaultAnchorTableName([])).toBeUndefined();
  });
});

describe("defaultJoinKeysByPair", () => {
  it("picks the highest-confidence approved match per unordered pair (Req 7.4)", () => {
    const low = makeMatch({ id: "a.x~b.y", confidence: 0.6 });
    const high = makeMatch({
      id: "a.z~b.w",
      left: { tableName: "a", columnName: "z", type: "string" },
      right: { tableName: "b", columnName: "w", type: "string" },
      confidence: 0.9,
    });
    const keys = defaultJoinKeysByPair([low, high]);
    expect(keys[pairKey("a", "b")]).toBe("a.z~b.w");
  });
});

describe("assembleStitchPlan", () => {
  it("includes only approved and edited proposals, dropping rejected/undecided", () => {
    const matchApproved = makeMatch({ id: "a.x~b.y", confidence: 0.9 });
    const matchRejected = makeMatch({ id: "a.p~b.q", confidence: 0.8 });
    const matchUndecided = makeMatch({ id: "a.r~b.s", confidence: 0.7 });
    const proposals: ProposalSet = {
      matches: [matchApproved, matchRejected, matchUndecided],
      cleanings: [],
      aiUsed: false,
    };
    const decisions: Record<string, ApprovalDecision> = {
      "a.x~b.y": { proposalId: "a.x~b.y", decision: "approved" },
      "a.p~b.q": { proposalId: "a.p~b.q", decision: "rejected" },
    };
    const plan = assembleStitchPlan(proposals, decisions, tables);
    expect(plan.approvedMatches.map((m) => m.id)).toEqual(["a.x~b.y"]);
    expect(plan.anchorTableName).toBe("b");
  });

  it("merges an edited match's re-pair override (Req 3.6)", () => {
    const base = makeMatch({ id: "a.x~b.y" });
    const proposals: ProposalSet = {
      matches: [base],
      cleanings: [],
      aiUsed: false,
    };
    const decisions: Record<string, ApprovalDecision> = {
      "a.x~b.y": {
        proposalId: "a.x~b.y",
        decision: "edited",
        edit: {
          id: "a.x~b.z",
          right: { tableName: "b", columnName: "z", type: "string" },
        },
      },
    };
    const plan = assembleStitchPlan(proposals, decisions, tables);
    expect(plan.approvedMatches).toHaveLength(1);
    expect(plan.approvedMatches[0].right.columnName).toBe("z");
    expect(plan.approvedMatches[0].id).toBe("a.x~b.z");
  });

  it("merges an edited category's canonical override (Req 3.7)", () => {
    const cat = makeCategory();
    const proposals: ProposalSet = {
      matches: [],
      cleanings: [cat],
      aiUsed: false,
    };
    const decisions: Record<string, ApprovalDecision> = {
      [cat.id]: {
        proposalId: cat.id,
        decision: "edited",
        edit: { canonical: "Crimson" },
      },
    };
    const plan = assembleStitchPlan(proposals, decisions, tables);
    expect(plan.approvedCleanings).toHaveLength(1);
    expect(plan.approvedCleanings[0].canonical).toBe("Crimson");
  });

  it("honors explicit anchor and join-key overrides", () => {
    const match = makeMatch({ id: "a.x~b.y", confidence: 0.9 });
    const proposals: ProposalSet = {
      matches: [match],
      cleanings: [],
      aiUsed: false,
    };
    const decisions: Record<string, ApprovalDecision> = {
      "a.x~b.y": { proposalId: "a.x~b.y", decision: "approved" },
    };
    const plan = assembleStitchPlan(proposals, decisions, tables, {
      anchorTableName: "c",
      joinKeysByPair: { [pairKey("a", "b")]: "override-id" },
    });
    expect(plan.anchorTableName).toBe("c");
    expect(plan.joinKeysByPair[pairKey("a", "b")]).toBe("override-id");
  });
});
