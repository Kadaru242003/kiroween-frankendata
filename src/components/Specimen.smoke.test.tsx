/**
 * Smoke test for the Little Frank mascot (component name: Specimen).
 *
 * Confirms it renders as a real "Poke Little Frank" button (keyboard reachable),
 * shows the asleep pose with no tables and the awake pose with tables, wears
 * bandages (the alive kit) when a stitched result exists, holds a bar-chart
 * sign when an Ask result is shown, connects its legs to the body, derives the
 * "Ask result shown" flag correctly, and does not throw when poked.
 */

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Specimen, isAskResultShown, type SpecimenProps } from "./Specimen";

const base: SpecimenProps = {
  tableCount: 0,
  proposalsShowing: false,
  approvedCount: 0,
  stitched: false,
  askPending: false,
  askResult: false,
  intakeError: false,
};

function renderSpecimen(overrides: Partial<SpecimenProps> = {}) {
  return render(<Specimen {...base} {...overrides} />);
}

describe("Specimen (Little Frank)", () => {
  it("renders a 'Poke Little Frank' button with aria-hidden body art", () => {
    const { getByRole, container } = renderSpecimen();
    const button = getByRole("button", { name: "Poke Little Frank" });
    expect(button).toBeInTheDocument();
    // The creature art itself is hidden from assistive tech.
    expect(container.querySelector(".specimen")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("shows the asleep pose with no tables", () => {
    const { container } = renderSpecimen({ tableCount: 0 });
    expect(container.querySelector(".specimen--asleep")).not.toBeNull();
    expect(container.querySelector(".specimen__zzz")).not.toBeNull();
  });

  it("shows the awake pose with tables", () => {
    const { container } = renderSpecimen({ tableCount: 2 });
    expect(container.querySelector(".specimen--awake")).not.toBeNull();
    expect(container.querySelector(".specimen--asleep")).toBeNull();
  });

  it("wears the alive kit (bandages) when a stitched result exists", () => {
    const { container } = renderSpecimen({ tableCount: 2, stitched: true });
    expect(container.querySelector(".specimen--alive")).not.toBeNull();
    expect(container.querySelector(".specimen__bandage")).not.toBeNull();
  });

  it("holds a bar-chart sign when an Ask result is shown, drawn after the body so it is not covered", () => {
    const { container } = renderSpecimen({ tableCount: 2, askResult: true });
    const sign = container.querySelector(".specimen__sign");
    const body = container.querySelector(".specimen__body");
    expect(sign).not.toBeNull();
    expect(body).not.toBeNull();
    // DOM order matters for paint order: the sign must come after the body.
    expect(
      body!.compareDocumentPosition(sign!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows no chart sign when there is no Ask result", () => {
    const { container } = renderSpecimen({ tableCount: 2, askResult: false });
    expect(container.querySelector(".specimen__sign")).toBeNull();
  });

  it("connects the legs to the body (no gap between grid and feet)", () => {
    const { container } = renderSpecimen({ tableCount: 2 });
    const frame = container.querySelector(".specimen__grid-frame");
    const leg = container.querySelector(".specimen__leg--left");
    const frameBottom =
      Number(frame!.getAttribute("y")) + Number(frame!.getAttribute("height"));
    const legTop = Number(leg!.getAttribute("y"));
    // The leg starts at or above the bottom edge of the body grid.
    expect(legTop).toBeLessThanOrEqual(frameBottom);
  });

  it("holds a magnifying glass while an Autopsy is open and not otherwise", () => {
    const open = renderSpecimen({ tableCount: 2, autopsyOpen: true });
    expect(open.container.querySelector(".specimen__magnifier")).not.toBeNull();
    expect(open.container.querySelector(".specimen--investigating")).not.toBeNull();
    open.unmount();

    const closed = renderSpecimen({ tableCount: 2 });
    expect(closed.container.querySelector(".specimen__magnifier")).toBeNull();
    expect(closed.container.querySelector(".specimen--investigating")).toBeNull();
  });

  it("suppresses the chart sign and clipboard while the magnifying glass shows", () => {
    const { container } = renderSpecimen({
      tableCount: 2,
      autopsyOpen: true,
      askResult: true,
      approvedCount: 2,
    });
    expect(container.querySelector(".specimen__magnifier")).not.toBeNull();
    expect(container.querySelector(".specimen__sign")).toBeNull();
    expect(container.querySelector(".specimen__clipboard")).toBeNull();
  });

  it("does not throw when poked", () => {
    const { getByRole } = renderSpecimen({ tableCount: 2 });
    const button = getByRole("button", { name: "Poke Little Frank" });
    expect(() => fireEvent.click(button)).not.toThrow();
  });
});

describe("isAskResultShown", () => {
  it("is true for an ok outcome that is not pending (typed question or chip)", () => {
    expect(isAskResultShown({ kind: "ok" }, false)).toBe(true);
  });

  it("is false while a new question is pending, even with a stale ok outcome", () => {
    expect(isAskResultShown({ kind: "ok" }, true)).toBe(false);
  });

  it("is false for no outcome, an error, or an unavailable outcome", () => {
    expect(isAskResultShown(null, false)).toBe(false);
    expect(isAskResultShown({ kind: "error" }, false)).toBe(false);
    expect(isAskResultShown({ kind: "ai-unavailable" }, false)).toBe(false);
  });
});
