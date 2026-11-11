/**
 * CleaningDiff rendering tests (Feature 2 polish, bug fixes 2 & 4).
 *
 * Item 2: duplicate-rows (and outliers) proposals carry a structured
 * `{ rowCount }` / `{ outliersFlagged, nonNull }` before/after payload, not a
 * scalar. The diff must show readable counts (e.g. "8 rows", "2 flagged")
 * instead of the "[object Object]" that a naive String(...) produced.
 *
 * Item 4: whitespace/case diffs must make leading/trailing/repeated spaces
 * visible (the browser otherwise collapses them) by rendering each space as a
 * middle dot in a `white-space: pre` span — WITHOUT changing the underlying
 * value handed to approve/apply.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CleaningDiff } from "./CleaningDiff";
import type { CleaningProposal } from "../../core/stitching/types";

const noop = vi.fn();

function renderDiff(proposal: CleaningProposal) {
  return render(
    <CleaningDiff
      proposal={proposal}
      onApprove={noop}
      onReject={noop}
      onEditCanonical={noop}
    />
  );
}

describe("CleaningDiff — count rendering (item 2)", () => {
  it("renders duplicate-rows before/after as row counts, not [object Object]", () => {
    const proposal: CleaningProposal = {
      id: "clean:duplicate-rows:monsters",
      target: { tableName: "monsters" },
      kind: "duplicate-rows",
      before: { rowCount: 8 },
      after: { rowCount: 6 },
      reason: "Remove 2 duplicate rows from monsters (8 → 6 rows).",
    };
    const { container } = renderDiff(proposal);

    expect(container.textContent).not.toContain("[object Object]");
    expect(screen.getByText("8 rows")).toBeInTheDocument();
    expect(screen.getByText("6 rows")).toBeInTheDocument();
  });

  it("renders outliers before/after as a flagged count, not [object Object]", () => {
    const proposal: CleaningProposal = {
      id: "clean:outliers:monsters.escape_risk",
      target: { tableName: "monsters", columnName: "escape_risk" },
      kind: "outliers",
      before: { outliersFlagged: 0, nonNull: 20 },
      after: { outliersFlagged: 2, nonNull: 20 },
      reason: "Flag 2 outlier values in monsters.escape_risk (Tukey fences).",
    };
    const { container } = renderDiff(proposal);

    expect(container.textContent).not.toContain("[object Object]");
    expect(screen.getByText("0 flagged")).toBeInTheDocument();
    expect(screen.getByText("2 flagged")).toBeInTheDocument();
  });
});

describe("CleaningDiff — visible whitespace (item 4)", () => {
  it("shows leading/trailing/repeated spaces with a middle-dot marker", () => {
    const proposal: CleaningProposal = {
      id: "clean:whitespace:monsters.species",
      target: { tableName: "monsters", columnName: "species" },
      kind: "whitespace-case",
      before: "  swamp  wraith ",
      after: "swamp wraith",
      reason: 'Trim and collapse whitespace in monsters.species.',
    };
    renderDiff(proposal);

    // Each space is rendered as a middle dot so it is visible; the real
    // characters are preserved around the markers.
    expect(
      screen.getByText("\u00B7\u00B7swamp\u00B7\u00B7wraith\u00B7")
    ).toBeInTheDocument();
    expect(screen.getByText("swamp\u00B7wraith")).toBeInTheDocument();
  });
});

describe("CleaningDiff — visible whitespace in the reason sentence (item 3)", () => {
  it("shows the example values inside the reason with middle-dot spaces", () => {
    const proposal: CleaningProposal = {
      id: "clean:whitespace:monsters.species",
      target: { tableName: "monsters", columnName: "species" },
      kind: "whitespace-case",
      before: "swamp  wraith",
      after: "swamp wraith",
      reason:
        'Trim and collapse whitespace in "monsters.species" (e.g. "swamp  wraith" -> "swamp wraith").',
    };
    renderDiff(proposal);

    // The quoted example values appear inside the sentence with their spaces
    // rendered as middle dots, so the before/after are visibly different.
    expect(
      screen.getByText('"swamp\u00B7\u00B7wraith"')
    ).toBeInTheDocument();
    expect(
      screen.getByText('"swamp\u00B7wraith"')
    ).toBeInTheDocument();
  });
});
