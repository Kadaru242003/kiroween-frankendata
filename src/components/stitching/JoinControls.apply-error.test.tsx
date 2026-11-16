import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StitchPlan } from "../../core/stitching/types";
import { JoinControls } from "./JoinControls";

const plan: StitchPlan = {
  anchorTableName: "a",
  joinKeysByPair: {},
  approvedMatches: [],
  approvedCleanings: [],
};
const tables = [{ tableName: "a", rowCount: 1 }];
const noop = vi.fn();

function renderIt(applyError: string | null) {
  return render(
    <JoinControls
      plan={plan}
      tables={tables}
      fanOut={null}
      applied={false}
      applyError={applyError}
      onChangeAnchor={noop}
      onChangeJoinKey={noop}
      onApply={noop}
      onCancel={noop}
    />
  );
}

describe("JoinControls apply error", () => {
  it("shows an alert next to the buttons and keeps Apply enabled for a retry", () => {
    renderIt("The stitch could not be applied. Nothing was changed. The browser ran out of memory.");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Nothing was changed.");
    expect(screen.getByRole("button", { name: "Apply & stitch" })).toBeEnabled();
  });
  it("shows no alert without an error", () => {
    renderIt(null);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
