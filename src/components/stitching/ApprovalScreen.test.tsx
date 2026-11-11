/**
 * Component tests for the ApprovalScreen + MatchDiff/CleaningDiff/EngineBadge
 * (Feature 2, task 13).
 *
 * Covers the design "UI Layer / edit semantics" behaviors (Req 3.1, 3.2, 3.3,
 * 3.5, 3.6, 3.7, 6.8):
 *   - lists match (≥ threshold) and cleaning proposals as before/after diffs;
 *   - per-proposal approve / reject / edit;
 *   - "approve all high-confidence" selects exactly the ≥ HIGH_CONFIDENCE set;
 *   - per-proposal engine badge (rules / ai);
 *   - plain-text rendering of AI/proposal text (no markup interpretation);
 *   - confirm assembles and surfaces the StitchPlan.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StitchStore } from "../../core/stitching/stitch-store";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  type CleaningProposal,
  type MatchProposal,
  type ProposalSet,
  type StitchPlan,
} from "../../core/stitching/types";
import {
  ApprovalScreen,
  type ApprovalScreenTable,
} from "./ApprovalScreen";

const tables: ApprovalScreenTable[] = [
  {
    tableName: "monsters",
    rowCount: 100,
    schema: [
      { name: "Monster Name", type: "string" },
      { name: "habitat", type: "string" },
    ],
  },
  {
    tableName: "experiments",
    rowCount: 40,
    schema: [
      { name: "name", type: "string" },
      { name: "subject", type: "string" },
    ],
  },
];

function highMatch(): MatchProposal {
  return {
    id: "monsters.Monster Name~experiments.name",
    left: { tableName: "monsters", columnName: "Monster Name", type: "string" },
    right: { tableName: "experiments", columnName: "name", type: "string" },
    confidence: 0.93,
    reason: "Both list the same creatures.",
    source: "rules",
    components: { nameSim: 0.7, typeCompat: 1, valueOverlap: 0.9 },
  };
}

function lowMatch(): MatchProposal {
  return {
    id: "monsters.habitat~experiments.subject",
    left: { tableName: "monsters", columnName: "habitat", type: "string" },
    right: { tableName: "experiments", columnName: "subject", type: "string" },
    confidence: 0.6,
    reason: "Weak name overlap.",
    source: "ai",
    components: { nameSim: 0.5, typeCompat: 1, valueOverlap: 0.2 },
  };
}

function categoryCleaning(): CleaningProposal {
  return {
    id: "clean-monsters-habitat",
    target: { tableName: "monsters", columnName: "habitat" },
    kind: "category-standardize",
    before: "swamp / Swamp / SWAMP",
    after: "Swamp",
    reason: "3 variants fold to 1.",
    canonical: "Swamp",
    variantMap: { swamp: "Swamp", SWAMP: "Swamp" },
  };
}

function seedStore(proposals: ProposalSet): StitchStore {
  const store = new StitchStore();
  store.setProposals(proposals, "v1", false);
  return store;
}

describe("ApprovalScreen", () => {
  let onConfirm: ReturnType<typeof vi.fn<(plan: StitchPlan) => void>>;

  beforeEach(() => {
    onConfirm = vi.fn<(plan: StitchPlan) => void>();
  });

  it("lists match and cleaning proposals as before/after diffs (Req 3.1)", () => {
    const store = seedStore({
      matches: [highMatch()],
      cleanings: [categoryCleaning()],
      aiUsed: false,
    });
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );

    expect(screen.getByText("Column match")).toBeInTheDocument();
    expect(screen.getByText("Category standardize")).toBeInTheDocument();
    // Before/after for the match pairing.
    expect(screen.getByText("monsters.Monster Name")).toBeInTheDocument();
    expect(screen.getByText("experiments.name")).toBeInTheDocument();
    // Before/after representative values for the cleaning.
    expect(screen.getByText("swamp / Swamp / SWAMP")).toBeInTheDocument();
    expect(screen.getByText("Swamp")).toBeInTheDocument();
  });

  it("shows a per-proposal engine badge for rules and ai (Req 6.8)", () => {
    const store = seedStore({
      matches: [highMatch(), lowMatch()],
      cleanings: [],
      aiUsed: true,
    });
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    const badges = screen.getAllByText(/^(rules|ai)$/);
    const labels = badges.map((b) => b.textContent);
    expect(labels).toContain("rules");
    expect(labels).toContain("ai");
  });

  it("records approve and reject decisions per proposal (Req 3.2)", () => {
    const match = highMatch();
    const store = seedStore({
      matches: [match],
      cleanings: [],
      aiUsed: false,
    });
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    const card = screen.getByRole("article", {
      name: /Match proposal/,
    });
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(store.getDecision(match.id)?.decision).toBe("approved");

    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    expect(store.getDecision(match.id)?.decision).toBe("rejected");
  });

  it("re-pairs a match to a different right column on edit (Req 3.6)", () => {
    const match = highMatch();
    const store = seedStore({
      matches: [match],
      cleanings: [],
      aiUsed: false,
    });
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    // The right table is `experiments`; re-pair to its other column "subject".
    const select = screen.getByLabelText(/Re-pair Monster Name to/);
    fireEvent.change(select, { target: { value: "subject" } });

    const decision = store.getDecision(match.id);
    expect(decision?.decision).toBe("edited");
    const edited = decision?.edit as Partial<MatchProposal>;
    expect(edited.right?.columnName).toBe("subject");
  });

  it("edits a category canonical value (Req 3.7)", () => {
    const cleaning = categoryCleaning();
    const store = seedStore({
      matches: [],
      cleanings: [cleaning],
      aiUsed: false,
    });
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    const input = screen.getByLabelText("Canonical value");
    fireEvent.change(input, { target: { value: "Bog" } });
    fireEvent.blur(input);

    const decision = store.getDecision(cleaning.id);
    expect(decision?.decision).toBe("edited");
    const edit = decision?.edit as Partial<CleaningProposal> | undefined;
    expect(edit?.canonical).toBe("Bog");
  });

  it("approve-all-high-confidence approves exactly the >= threshold matches (Req 3.3)", () => {
    const high = highMatch(); // 0.93 >= 0.85
    const low = lowMatch(); // 0.60 < 0.85
    expect(high.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
    expect(low.confidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD);

    const store = seedStore({
      matches: [high, low],
      cleanings: [],
      aiUsed: false,
    });
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve all high-confidence" })
    );
    expect(store.getDecision(high.id)?.decision).toBe("approved");
    expect(store.getDecision(low.id)).toBeUndefined();
  });

  it("assembles and surfaces the plan only on confirm (Req 3.5)", () => {
    const match = highMatch();
    const store = seedStore({
      matches: [match],
      cleanings: [],
      aiUsed: false,
    });
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    // Nothing assembled before confirm.
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/ }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const plan = onConfirm.mock.calls[0][0];
    expect(plan.approvedMatches.map((m: MatchProposal) => m.id)).toEqual([
      match.id,
    ]);
    // The anchor defaults to the most-rows table (monsters, 100 rows).
    expect(plan.anchorTableName).toBe("monsters");
    expect(store.getState().plan).not.toBeNull();
  });

  it("renders proposal/AI text as plain text, never as markup (Req 6.8)", () => {
    const match = highMatch();
    match.source = "ai";
    match.reason = '<img src=x onerror="alert(1)"> **bold**';
    const store = seedStore({
      matches: [match],
      cleanings: [],
      aiUsed: true,
    });
    const { container } = render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    // The literal string is present as a text node...
    expect(
      screen.getByText('<img src=x onerror="alert(1)"> **bold**')
    ).toBeInTheDocument();
    // ...and no <img> element was ever created from it (React escaped it).
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows an empty state when there are no proposals", () => {
    const store = new StitchStore();
    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    expect(screen.getByText(/No proposals yet/)).toBeInTheDocument();
  });

  it("\"Approve all suggestions\" approves every pending proposal but not already-rejected ones (item 2)", () => {
    const match = highMatch();
    const low = lowMatch();
    const cleaning = categoryCleaning();
    const store = seedStore({
      matches: [match, low],
      cleanings: [cleaning],
      aiUsed: false,
    });
    // The user has already REJECTED the low match before bulk-approving.
    store.setDecision({ proposalId: low.id, decision: "rejected" });

    render(
      <ApprovalScreen store={store} tables={tables} onConfirm={onConfirm} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve all suggestions" })
    );

    // Pending match + cleaning are now approved...
    expect(store.getDecision(match.id)?.decision).toBe("approved");
    expect(store.getDecision(cleaning.id)?.decision).toBe("approved");
    // ...but the explicit reject is preserved (not overridden).
    expect(store.getDecision(low.id)?.decision).toBe("rejected");

    // Per-card controls still work afterwards. Target the low MATCH card
    // specifically (the category cleaning also targets monsters.habitat).
    const lowCard = screen.getByRole("article", {
      name: /Match proposal.*habitat.*subject/,
    });
    fireEvent.click(within(lowCard).getByRole("button", { name: "Approve" }));
    expect(store.getDecision(low.id)?.decision).toBe("approved");
  });

});
