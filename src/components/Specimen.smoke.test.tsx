/**
 * Smoke test for the Little Frank mascot (component name: Specimen).
 *
 * Confirms it renders as a real "Ask Little Frank" button (keyboard reachable),
 * shows the asleep pose with no tables and the awake pose with tables, wears
 * bandages (the alive kit) when a stitched result exists, holds a bar-chart
 * sign when an Ask result is shown, connects its legs to the body, derives the
 * "Ask result shown" flag correctly, and does not throw when poked.
 */

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  it("renders an 'Ask Little Frank' button with aria-hidden body art", () => {
    const { getByRole, container } = renderSpecimen();
    const button = getByRole("button", { name: "Ask Little Frank" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");
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

  it("holds a stethoscope and clipboard while an Autopsy is open and not otherwise", () => {
    const open = renderSpecimen({ tableCount: 2, autopsyOpen: true });
    expect(open.container.querySelector(".specimen__stethoscope")).not.toBeNull();
    expect(open.container.querySelector(".specimen__clipboard")).not.toBeNull();
    expect(open.container.querySelector(".specimen__magnifier")).toBeNull();
    expect(open.container.querySelector(".specimen--investigating")).not.toBeNull();
    open.unmount();

    const closed = renderSpecimen({ tableCount: 2 });
    expect(closed.container.querySelector(".specimen__stethoscope")).toBeNull();
    expect(closed.container.querySelector(".specimen--investigating")).toBeNull();
  });

  it("suppresses the chart sign and approval clipboard while the Autopsy gear shows", () => {
    const { container } = renderSpecimen({
      tableCount: 2,
      autopsyOpen: true,
      askResult: true,
      approvedCount: 2,
    });
    expect(container.querySelector(".specimen__stethoscope")).not.toBeNull();
    expect(container.querySelector(".specimen__sign")).toBeNull();
    // Only the Autopsy clipboard (with text lines), not the approval one (with a check).
    expect(container.querySelectorAll(".specimen__clipboard")).toHaveLength(1);
    expect(container.querySelector(".specimen__clipboard polyline")).toBeNull();
  });

  it("asks the owner to toggle the guide when clicked, and reports it open", () => {
    const onToggleGuide = vi.fn();
    const { getByRole, rerender } = renderSpecimen({ tableCount: 2, onToggleGuide });
    fireEvent.click(getByRole("button", { name: "Ask Little Frank" }));
    expect(onToggleGuide).toHaveBeenCalledTimes(1);
    rerender(<Specimen {...base} tableCount={2} guideOpen onToggleGuide={onToggleGuide} />);
    expect(getByRole("button", { name: "Ask Little Frank" })).toHaveAttribute("aria-expanded", "true");
  });

  it("holds a bubbling flask while a question is pending, and no chart sign", () => {
    const { container } = renderSpecimen({ tableCount: 2, askPending: true, askResult: true });
    expect(container.querySelector(".specimen__flask")).not.toBeNull();
    expect(container.querySelectorAll(".specimen__flask-bubble").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector(".specimen__sign")).toBeNull();
  });

  it("sleeps when idle, even with tables loaded", () => {
    const { container } = renderSpecimen({ tableCount: 2, idle: true });
    expect(container.querySelector(".specimen--asleep")).not.toBeNull();
    expect(container.querySelector(".specimen__zzz")).not.toBeNull();
  });

  it("has neck bolts", () => {
    const { container } = renderSpecimen({ tableCount: 2 });
    expect(container.querySelectorAll(".specimen__neckbolt")).toHaveLength(2);
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
  it("holds a recipe scroll after a recipe is applied, off by default", () => {
    const on = renderSpecimen({ tableCount: 2, recipeApplied: true, askResult: true, approvedCount: 2 });
    expect(on.container.querySelector(".specimen__scroll")).not.toBeNull();
    expect(on.container.querySelector(".specimen__sign")).toBeNull();
    expect(on.container.querySelector(".specimen__clipboard")).toBeNull();
    on.unmount();
    const off = renderSpecimen({ tableCount: 2 });
    expect(off.container.querySelector(".specimen__scroll")).toBeNull();
  });
  it("the Autopsy gear takes priority over the recipe scroll", () => {
    const { container } = renderSpecimen({ tableCount: 2, recipeApplied: true, autopsyOpen: true });
    expect(container.querySelector(".specimen__stethoscope")).not.toBeNull();
    expect(container.querySelector(".specimen__scroll")).toBeNull();
  });
});

describe("reactions are drawn from props", () => {
  const wake = { id: "wake" as const, bubble: "IT'S ALIVE!", durationMs: 1400 };

  it("the wake draws the lightning and the flash, shows the bubble, and sets the reaction class", () => {
    const { container, getByTestId } = renderSpecimen({ tableCount: 2, reaction: wake, reactionSeq: 1, bubble: wake.bubble, reducedMotion: false });
    expect(getByTestId("frank-lightning")).toBeInTheDocument();
    expect(getByTestId("frank-flash")).toBeInTheDocument();
    expect(container.querySelector(".specimen--react-wake")).not.toBeNull();
    expect(container.querySelector(".specimen__bubble")?.textContent).toBe("IT'S ALIVE!");
    expect(container.querySelector(".specimen__fx")).not.toBeNull();
  });

  it("under reduced motion there is no lightning, no flash and no effects, but the pose and bubble remain", () => {
    const { container, queryByTestId } = renderSpecimen({ tableCount: 2, reaction: wake, reactionSeq: 1, bubble: wake.bubble, reducedMotion: true });
    expect(queryByTestId("frank-lightning")).toBeNull();
    expect(queryByTestId("frank-flash")).toBeNull();
    expect(container.querySelector(".specimen__fx")).toBeNull();
    expect(container.querySelector(".specimen--still")).not.toBeNull();
    expect(container.querySelector(".specimen--react-wake")).not.toBeNull();
    expect(container.querySelector(".specimen__bubble")?.textContent).toBe("IT'S ALIVE!");
  });

  it("Calm Frank does the same as reduced motion", () => {
    const { container, queryByTestId } = renderSpecimen({ tableCount: 2, reaction: wake, reactionSeq: 1, bubble: wake.bubble, calm: true, reducedMotion: false });
    expect(queryByTestId("frank-lightning")).toBeNull();
    expect(container.querySelector(".specimen--still")).not.toBeNull();
    expect(container.querySelector(".specimen__bubble")).not.toBeNull();
  });

  it("restarts an effect for the same reaction twice (the sequence is its key)", () => {
    const first = renderSpecimen({ tableCount: 2, reaction: wake, reactionSeq: 1, reducedMotion: false });
    const a = first.getByTestId("frank-lightning");
    first.rerender(<Specimen {...base} tableCount={2} reaction={wake} reactionSeq={2} reducedMotion={false} />);
    expect(first.getByTestId("frank-lightning")).not.toBe(a);
  });

  it("draws effects for other reactions and none for pose-only ones", () => {
    const sew = renderSpecimen({ tableCount: 2, reaction: { id: "sew", bubble: null, durationMs: 1400 }, reactionSeq: 1, reducedMotion: false });
    expect(sew.container.querySelector(".fx-thread")).not.toBeNull();
    expect(sew.container.querySelector(".fx-needle")).not.toBeNull();
    sew.unmount();
    const nod = renderSpecimen({ tableCount: 2, reaction: { id: "nod", bubble: null, durationMs: 600 }, reactionSeq: 1, reducedMotion: false });
    expect(nod.container.querySelector(".specimen__fx")).toBeNull();
    expect(nod.container.querySelector(".specimen--react-nod")).not.toBeNull();
  });

  it("steps the bubble aside while the guide is open", () => {
    const { container } = renderSpecimen({ tableCount: 2, bubble: "Hi!", guideOpen: true });
    expect(container.querySelector(".specimen__bubble")).toBeNull();
  });

  it("follows the cursor with the eyes only when awake and motion is allowed", () => {
    const on = renderSpecimen({ tableCount: 2, reducedMotion: false });
    const root = on.container.querySelector(".specimen") as HTMLElement;
    root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 94, height: 140, right: 94, bottom: 140, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, clientY: 30 }));
    expect(root.style.getPropertyValue("--eye-x")).not.toBe("");
    expect(parseFloat(root.style.getPropertyValue("--eye-x"))).toBeGreaterThan(0);
    // Out of range: no offset.
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 2000, clientY: 30 }));
    expect(parseFloat(root.style.getPropertyValue("--eye-x"))).toBe(0);
    on.unmount();
    const off = renderSpecimen({ tableCount: 2, calm: true });
    const root2 = off.container.querySelector(".specimen") as HTMLElement;
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, clientY: 30 }));
    expect(root2.style.getPropertyValue("--eye-x")).toBe("");
    raf.mockRestore();
  });
});
