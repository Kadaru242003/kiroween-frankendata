/**
 * Component tests for JoinControls (Feature 2, task 14; design "UI Layer /
 * JoinControls", Req 7.2, 7.4, 7.9, 7.11).
 *
 * Covers:
 *   - shows the LEFT JOIN type and the current anchor (Req 7.2);
 *   - changing the anchor reports the new table name (Req 7.2);
 *   - picking a different approved match as a pair's join key reports it (Req
 *     7.4);
 *   - the many-to-many fan-out warning shows the before/after row counts and a
 *     cancel action only when the join fanned out (Req 7.9);
 *   - apply/undo intents bubble through the callbacks;
 *   - proposal/table text is rendered as plain text (no markup).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FanOutCounts } from "../../core/stitching/stitch-applier";
import { pairKey } from "../../core/stitching/plan-assembly";
import type {
  MatchProposal,
  StitchPlan,
} from "../../core/stitching/types";
import { JoinControls, type JoinControlsTable } from "./JoinControls";

const tables: JoinControlsTable[] = [
  { tableName: "monsters", rowCount: 100 },
  { tableName: "experiments", rowCount: 40 },
];

function match(
  left: [string, string],
  right: [string, string],
  confidence: number,
  id: string
): MatchProposal {
  return {
    id,
    left: { tableName: left[0], columnName: left[1], type: "string" },
    right: { tableName: right[0], columnName: right[1], type: "string" },
    confidence,
    reason: "test",
    source: "rules",
    components: { nameSim: confidence, typeCompat: 1, valueOverlap: confidence },
  };
}

const highKey = match(
  ["monsters", "name"],
  ["experiments", "name"],
  0.93,
  "m-high"
);
const altKey = match(
  ["monsters", "habitat"],
  ["experiments", "subject"],
  0.6,
  "m-alt"
);

function plan(overrides: Partial<StitchPlan> = {}): StitchPlan {
  return {
    anchorTableName: "monsters",
    joinKeysByPair: {},
    approvedMatches: [highKey, altKey],
    approvedCleanings: [],
    ...overrides,
  };
}

describe("JoinControls", () => {
  let onChangeAnchor: ReturnType<typeof vi.fn<(t: string) => void>>;
  let onChangeJoinKey: ReturnType<typeof vi.fn<(k: string, m: string) => void>>;
  let onApply: ReturnType<typeof vi.fn<() => void>>;
  let onCancel: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    onChangeAnchor = vi.fn();
    onChangeJoinKey = vi.fn();
    onApply = vi.fn();
    onCancel = vi.fn();
  });

  function renderControls(
    plansArg: StitchPlan,
    fanOut: FanOutCounts | null,
    applied: boolean
  ) {
    return render(
      <JoinControls
        plan={plansArg}
        tables={tables}
        fanOut={fanOut}
        applied={applied}
        onChangeAnchor={onChangeAnchor}
        onChangeJoinKey={onChangeJoinKey}
        onApply={onApply}
        onCancel={onCancel}
      />
    );
  }

  it("shows the LEFT JOIN type and the current anchor (Req 7.2)", () => {
    renderControls(plan(), null, false);
    expect(screen.getByText("LEFT JOIN")).toBeInTheDocument();
    const anchor = screen.getByLabelText("Anchor table") as HTMLSelectElement;
    expect(anchor.value).toBe("monsters");
  });

  it("anchor label shows the CLEANED row count when a duplicate-rows cleaning is approved (item 3)", () => {
    // monsters starts at 100 rows; an approved duplicate-rows cleaning will
    // dedupe it to 94 before the join reads it. The anchor option must show 94
    // (the count the join actually uses, matching the fan-out "Before"), not
    // the raw 100. The anchor override still lists every table.
    const p = plan({
      approvedCleanings: [
        {
          id: "clean:duplicate-rows:monsters",
          target: { tableName: "monsters" },
          kind: "duplicate-rows",
          before: { rowCount: 100 },
          after: { rowCount: 94 },
          reason: "Remove 6 duplicate rows from monsters (100 \u2192 94 rows).",
        },
      ],
    });
    renderControls(p, null, false);

    const anchor = screen.getByLabelText("Anchor table") as HTMLSelectElement;
    const options = within(anchor).getAllByRole(
      "option"
    ) as HTMLOptionElement[];
    const monstersOption = options.find((o) => o.value === "monsters")!;
    const experimentsOption = options.find((o) => o.value === "experiments")!;
    expect(monstersOption.textContent).toContain("94 rows");
    expect(monstersOption.textContent).not.toContain("100 rows");
    // A table with no approved cleaning still shows its raw count.
    expect(experimentsOption.textContent).toContain("40 rows");
  });

  it("changing the anchor reports the new table (Req 7.2)", () => {
    renderControls(plan(), null, false);
    const anchor = screen.getByLabelText("Anchor table");
    fireEvent.change(anchor, { target: { value: "experiments" } });
    expect(onChangeAnchor).toHaveBeenCalledWith("experiments");
  });

  it("picks a different approved match as a pair's join key (Req 7.4)", () => {
    // Two approved matches on the SAME pair so the user can choose between them.
    const sameKeyAlt = match(
      ["monsters", "alias"],
      ["experiments", "codename"],
      0.7,
      "m-same-alt"
    );
    const p = plan({ approvedMatches: [highKey, sameKeyAlt] });
    renderControls(p, null, false);

    const key = pairKey("monsters", "experiments");
    // The pair label uses the sorted table order (experiments < monsters).
    const select = screen.getByLabelText(
      /experiments ↔ monsters key/
    ) as HTMLSelectElement;
    // Default selects the highest-confidence match.
    expect(select.value).toBe("m-high");
    fireEvent.change(select, { target: { value: "m-same-alt" } });
    expect(onChangeJoinKey).toHaveBeenCalledWith(key, "m-same-alt");
  });

  it("shows no fan-out warning when the join did not fan out (Req 7.9)", () => {
    renderControls(plan(), {
      anchorRowCount: 100,
      resultRowCount: 100,
      fannedOut: false,
    }, true);
    expect(
      screen.queryByRole("alert", { name: "Many-to-many warning" })
    ).not.toBeInTheDocument();
  });

  it("shows the many-to-many warning with before/after counts and cancel (Req 7.9)", () => {
    renderControls(plan(), {
      anchorRowCount: 100,
      resultRowCount: 250,
      fannedOut: true,
    }, true);
    const warning = screen.getByRole("alert", { name: "Many-to-many warning" });
    expect(warning).toBeInTheDocument();
    // Before/after row counts are shown.
    expect(within(warning).getByText(/Before:/)).toHaveTextContent(
      "Before: 100 rows"
    );
    expect(within(warning).getByText(/Before:/)).toHaveTextContent(
      "After: 250 rows"
    );
    // Cancel action undoes the apply.
    fireEvent.click(
      within(warning).getByRole("button", { name: /Cancel/ })
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("fires apply before stitching and shows an undo control after (Req 7.11)", () => {
    const { rerender } = renderControls(plan(), null, false);
    const apply = screen.getByRole("button", { name: "Apply & stitch" });
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);

    // Once applied, the apply button is disabled and an Undo control appears.
    rerender(
      <JoinControls
        plan={plan()}
        tables={tables}
        fanOut={{ anchorRowCount: 100, resultRowCount: 100, fannedOut: false }}
        applied
        onChangeAnchor={onChangeAnchor}
        onChangeJoinKey={onChangeJoinKey}
        onApply={onApply}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("button", { name: "Stitched" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo stitch" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders table/column text as plain text, never markup", () => {
    const evil = match(
      ["monsters", '<img src=x onerror="alert(1)">'],
      ["experiments", "name"],
      0.8,
      "m-evil"
    );
    const { container } = renderControls(
      plan({ approvedMatches: [evil] }),
      null,
      false
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
