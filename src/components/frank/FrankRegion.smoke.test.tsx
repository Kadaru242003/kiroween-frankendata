import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StitchStore } from "../../core/stitching/stitch-store";
import { AskStore } from "../../state/ask-store";
import { frankBus } from "../../state/frank-bus";
import { FrankRegion, type FrankRegionProps } from "./FrankRegion";

function setup(over: Partial<FrankRegionProps> = {}) {
  const stitchStore = new StitchStore();
  const askStore = new AskStore();
  const base: FrankRegionProps = {
    recipeBase: null,
    autopsyOpen: false,
    tableCount: 0,
    intakeError: false,
    stitchStore,
    askStore,
    aiOn: true,
    stitchOpen: false,
    resetting: false,
    ...over,
  };
  const view = render(<FrankRegion {...base} />);
  const update = (next: Partial<FrankRegionProps>) =>
    view.rerender(<FrankRegion {...base} {...next} />);
  return { view, update, stitchStore, askStore };
}

const bubble = (c: HTMLElement) => c.querySelector(".specimen__bubble")?.textContent ?? null;

describe("FrankRegion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("wakes with lightning and IT'S ALIVE! on the first load, and drops the same-load catch", () => {
    const { view, update } = setup();
    expect(view.container.querySelector('[data-testid="frank-lightning"]')).toBeNull();
    act(() => update({ tableCount: 2 }));
    expect(bubble(view.container)).toBe("It's alive!");
    expect(view.container.querySelector('[data-testid="frank-lightning"]')).not.toBeNull();
    act(() => update({ tableCount: 3 }));
    expect(bubble(view.container)).toBe("It's alive!");
  });

  it("peers when the stitch screen opens", () => {
    const { view, update } = setup({ tableCount: 2 });
    act(() => update({ tableCount: 2, stitchOpen: true }));
    expect(view.container.querySelector(".specimen--react-peer")).not.toBeNull();
  });

  it("shows the unplug reaction when AI is switched off", () => {
    const { view, update } = setup({ tableCount: 2 });
    act(() => update({ tableCount: 2, aiOn: false }));
    expect(bubble(view.container)).toMatch(/^Fully local\./);
  });

  it("reacts to bus events: export waves", () => {
    const { view } = setup({ tableCount: 2 });
    act(() => frankBus.emit({ type: "export" }));
    expect(bubble(view.container)).toBe("Farewell, little file!");
  });

  it("pokes when Frank is tapped, escalating, and does not open the guide", () => {
    const { view } = setup({ tableCount: 2 });
    const poke = screen.getByRole("button", { name: "Poke Little Frank" });
    fireEvent.click(poke);
    expect(bubble(view.container)).toBe("Oh! Good day to you.");
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(poke);
    expect(bubble(view.container)).toBe("You are curious, as am I.");
    expect(view.container.querySelector(".specimen--react-poke-2")).not.toBeNull();
  });

  it("a poke before any data is sleepy: a bubble and Zzz, no wake, no lightning, one bubble for quick repeats", () => {
    const { view } = setup({ tableCount: 0 });
    const poke = screen.getByRole("button", { name: "Poke Little Frank" });
    fireEvent.click(poke);
    expect(bubble(view.container)).toBe("5 more minutes...");
    expect(view.container.querySelector(".specimen--asleep")).not.toBeNull();
    expect(view.container.querySelector(".specimen__zzz")).not.toBeNull();
    expect(view.container.querySelector('[data-testid="frank-lightning"]')).toBeNull();
    expect(view.container.querySelector(".specimen--react-sleepy")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.click(poke);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // The repeat kept the same bubble on screen (4s after the first poke).
    expect(bubble(view.container)).toBe("5 more minutes...");
    expect(view.container.querySelector(".specimen--react-poke-1, .specimen--react-poke-2")).toBeNull();
    // Alive again: pokes work as before, starting from the first level.
    view.unmount();
    const alive = setup({ tableCount: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Poke Little Frank" }));
    expect(bubble(alive.view.container)).toBe("Oh! Good day to you.");
  });

  it("opens the guide from the '?' button, and a poke with it open does not close it", () => {
    setup({ tableCount: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Ask Little Frank" }));
    expect(screen.getByRole("dialog", { name: "Ask Little Frank" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /poke/i })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Poke Little Frank" }));
    fireEvent.click(screen.getByRole("button", { name: "Poke Little Frank" }));
    expect(screen.getByRole("dialog", { name: "Ask Little Frank" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("makes a rare idle quip only when quiet, then not again for two minutes", () => {
    const { view } = setup({ tableCount: 2, controller: { idleMs: 10 * 60_000, quipCheckMs: 5000, random: () => 0 } });
    // Quiet for the first check: no quip yet (the gap since waking is under two minutes).
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(view.container.querySelector("[class*='specimen--react-quip']")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    const quip = view.container.querySelector("[class*='specimen--react-quip']");
    expect(quip).not.toBeNull();
    // The reaction ends, and another one is not due for two minutes.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(view.container.querySelector("[class*='specimen--react-quip']")).toBeNull();
  });

  it("sleeps after the idle time and wakes on pointer movement", () => {
    const { view } = setup({ tableCount: 2, controller: { idleMs: 1000 } });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(view.container.querySelector(".specimen--asleep")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5 }));
    });
    expect(view.container.querySelector(".specimen--asleep")).toBeNull();
  });
});
