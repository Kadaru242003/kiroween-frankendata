import { act, render } from "@testing-library/react";
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
    expect(bubble(view.container)).toBe("IT'S ALIVE!");
    expect(view.container.querySelector('[data-testid="frank-lightning"]')).not.toBeNull();
    act(() => update({ tableCount: 3 }));
    expect(bubble(view.container)).toBe("IT'S ALIVE!");
  });

  it("peers when the stitch screen opens", () => {
    const { view, update } = setup({ tableCount: 2 });
    act(() => update({ tableCount: 2, stitchOpen: true }));
    expect(view.container.querySelector(".specimen--react-peer")).not.toBeNull();
  });

  it("shows the unplug reaction when AI is switched off", () => {
    const { view, update } = setup({ tableCount: 2 });
    act(() => update({ tableCount: 2, aiOn: false }));
    expect(bubble(view.container)).toBe("Fully local.");
  });

  it("reacts to bus events: export waves", () => {
    const { view } = setup({ tableCount: 2 });
    act(() => frankBus.emit({ type: "export" }));
    expect(bubble(view.container)).toBe("Bye, little file!");
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
