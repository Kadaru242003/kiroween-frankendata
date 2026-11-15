import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactionFor } from "../../core/frank/reactions";
import { StitchStore } from "../../core/stitching/stitch-store";
import type { LoadedTable } from "../../core/types";
import { AskStore } from "../../state/ask-store";
import { frankBus } from "../../state/frank-bus";
import { frankFeed } from "../../state/frank-feed";
import { JAR_LEAVE_MS, LabShelf, type LabShelfProps } from "./LabShelf";

const table = (tableName: string, rowCount: number) => ({ tableName, rowCount }) as unknown as LoadedTable;
const two = [table("crm_customers", 22), table("billing_invoices", 48)];

let wide = true;
let reduced = false;
function mockMedia() {
  window.matchMedia = ((query: string) => ({
    matches: /min-width/.test(query) ? wide : /prefers-reduced-motion/.test(query) ? reduced : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** A controllable IntersectionObserver: tests say which sections cross the middle. */
const observers: FakeIO[] = [];
class FakeIO {
  targets = new Set<Element>();
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    observers.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  cross(section: string, isIntersecting: boolean) {
    const target = [...this.targets].find((t) => (t as HTMLElement).dataset.labSection === section);
    if (!target) throw new Error(`section ${section} is not observed`);
    this.cb([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const publish = (id: Parameters<typeof reactionFor>[0], seq: number, calm = false, idle = false) =>
  act(() => frankFeed.publish({ reaction: reactionFor(id), seq, calm, idle }));
const rest = (calm = false, idle = false) => act(() => frankFeed.publish({ reaction: null, seq: 0, calm, idle }));

function setup(over: Partial<LabShelfProps> = {}) {
  const stitchStore = new StitchStore();
  const askStore = new AskStore();
  const props: LabShelfProps = {
    tables: two,
    stitchStore,
    askStore,
    stitchOpen: false,
    autopsyTableName: null,
    ...over,
  };
  const view = render(<LabShelf {...props} />);
  const update = (next: Partial<LabShelfProps>) => view.rerender(<LabShelf {...props} {...next} />);
  return { view, update, stitchStore, askStore, props };
}
const names = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button.shelf-jar")).map((b) => b.getAttribute("aria-label"));
const proposalSet = { matches: [{ id: "m1" }, { id: "m2" }], cleanings: [{ id: "c1" }], aiUsed: false } as never;
const applied = (name: string, rows: number): [never, { createdTableNames: string[] }, never] => [
  table(name, rows) as never,
  { createdTableNames: [] },
  { fannedOut: false } as never,
];

describe("LabShelf (page navigation)", () => {
  beforeEach(() => {
    wide = true;
    reduced = false;
    mockMedia();
    observers.length = 0;
    vi.stubGlobal("IntersectionObserver", FakeIO);
    rest(false, false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("is a nav named 'Lab sections', and not rendered below 1440px", () => {
    const narrow = (() => {
      wide = false;
      mockMedia();
      return setup();
    })();
    expect(narrow.view.container.querySelector(".lab-shelf")).toBeNull();
    narrow.view.unmount();
    wide = true;
    mockMedia();
    setup();
    expect(screen.getByRole("navigation", { name: "Lab sections" })).toBeInTheDocument();
  });

  it("shows only the Intake jar with no tables", () => {
    const { view } = setup({ tables: [] });
    expect(names(view.container)).toEqual(["Go to Intake"]);
    expect(view.container.querySelector("button.shelf-jar")).toHaveAttribute("data-progress", "empty");
  });

  it("shows Intake, Tables and Ask once tables are loaded, with names under the jars, no per-table jars", () => {
    const { view } = setup();
    expect(names(view.container)).toEqual(["Go to Intake", "Go to Tables", "Go to Ask the Lab"]);
    const texts = Array.from(view.container.querySelectorAll(".shelf-jar__text")).map((e) => e.textContent);
    expect(texts).toEqual(["Intake", "Tables", "Ask"]);
    expect(view.container.querySelector(".shelf-coil--powered")).not.toBeNull();
  });

  it("puts the table names and row counts in the Tables tooltip, wired with aria-describedby", () => {
    const { view } = setup();
    const jar = screen.getByRole("button", { name: "Go to Tables" });
    const tip = view.container.querySelector(`#${jar.getAttribute("aria-describedby")}`)!;
    expect(tip).toHaveAttribute("role", "tooltip");
    expect(tip.textContent).toBe("Tables: crm_customers 22 rows, billing_invoices 48 rows");
  });

  it("adds Stitching while proposals exist, Result and Recipes after a stitch, Autopsy while one is open", () => {
    const { view, update, stitchStore } = setup({ stitchOpen: true });
    act(() => stitchStore.setProposals(proposalSet, "v1", false));
    expect(names(view.container)).toEqual(["Go to Intake", "Go to Tables", "Go to Stitching", "Go to Ask the Lab"]);
    expect(screen.getByRole("button", { name: "Go to Stitching" })).toHaveAttribute("data-progress", "half");
    act(() => stitchStore.setDecision({ proposalId: "m1", decision: "approved" }));
    act(() => stitchStore.setDecision({ proposalId: "m2", decision: "approved" }));
    const tip = (name: string) => view.container.querySelector(`#shelf-tip-${name}`)!.textContent;
    expect(tip("stitching")).toBe("Stitching: 2 of 3 approved");

    act(() => stitchStore.setApplied(...applied("stitch_1_result", 48)));
    expect(names(view.container)).toEqual([
      "Go to Intake", "Go to Tables", "Go to Stitching", "Go to Result", "Go to Recipes", "Go to Ask the Lab",
    ]);
    expect(screen.getByRole("button", { name: "Go to Result" })).toHaveAttribute("data-progress", "full");
    expect(screen.getByRole("button", { name: "Go to Stitching" })).toHaveAttribute("data-progress", "full");
    expect(tip("result")).toBe("Result: 48 rows");
    expect(screen.getByRole("button", { name: "Go to Recipes" })).toHaveAttribute("data-progress", "empty");

    update({ autopsyTableName: "crm_customers" });
    expect(names(view.container)).toContain("Go to Autopsy");
    expect(screen.getByRole("button", { name: "Go to Autopsy" })).toHaveAttribute("data-progress", "half");
    act(() => frankBus.emit({ type: "autopsy", score: 81 }));
    expect(screen.getByRole("button", { name: "Go to Autopsy" })).toHaveAttribute("data-progress", "full");
    expect(tip("autopsy")).toBe("Autopsy: crm_customers, health score 81");
  });

  it("fills Recipes after Save recipe or Apply recipe, and Ask after the first answer", () => {
    const { stitchStore, askStore } = setup({ stitchOpen: true });
    act(() => stitchStore.setProposals(proposalSet, "v1", false));
    act(() => stitchStore.setApplied(...applied("stitch_1_result", 48)));
    act(() => frankBus.emit({ type: "save-recipe" }));
    expect(screen.getByRole("button", { name: "Go to Recipes" })).toHaveAttribute("data-progress", "full");
    const ask = screen.getByRole("button", { name: "Go to Ask the Lab" });
    expect(ask).toHaveAttribute("data-progress", "empty");
    act(() => askStore.setLoading(true));
    expect(ask).toHaveAttribute("data-progress", "half");
    act(() => askStore.setOutcome({ kind: "ok" } as never));
    expect(ask).toHaveAttribute("data-progress", "full");
  });

  it("scrolls the section into view (smooth, or at once under reduced motion) and focuses its heading", () => {
    const ask = document.createElement("section");
    ask.setAttribute("data-lab-section", "ask");
    ask.innerHTML = '<h2 id="ask-h">Ask the Lab</h2>';
    const scroll = vi.fn();
    ask.scrollIntoView = scroll;
    document.body.appendChild(ask);
    const intake = document.createElement("section");
    intake.setAttribute("data-lab-section", "intake");
    intake.scrollIntoView = vi.fn();
    document.body.appendChild(intake);
    const { view } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Go to Ask the Lab" }));
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(document.getElementById("ask-h")).toHaveFocus();
    // A section with no heading (the intake) takes the focus itself.
    fireEvent.click(screen.getByRole("button", { name: "Go to Intake" }));
    expect(intake).toHaveFocus();
    view.unmount();
    reduced = true;
    mockMedia();
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Go to Ask the Lab" }));
    expect(scroll).toHaveBeenLastCalledWith({ behavior: "auto", block: "start" });
  });

  it("highlights the jar of the section in view with aria-current", () => {
    for (const id of ["intake", "tables", "ask"]) {
      const el = document.createElement("section");
      el.setAttribute("data-lab-section", id);
      document.body.appendChild(el);
    }
    setup();
    const io = observers[observers.length - 1];
    act(() => io.cross("ask", true));
    expect(screen.getByRole("button", { name: "Go to Ask the Lab" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Go to Tables" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Go to Ask the Lab" }).className).toContain("shelf-jar--active");
    act(() => {
      io.cross("ask", false);
      io.cross("tables", true);
    });
    expect(screen.getByRole("button", { name: "Go to Tables" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Go to Ask the Lab" })).not.toHaveAttribute("aria-current");
  });

  it("keeps a clicked jar current until the user scrolls by hand", () => {
    for (const id of ["intake", "tables", "ask"]) {
      const el = document.createElement("section");
      el.setAttribute("data-lab-section", id);
      el.scrollIntoView = vi.fn();
      document.body.appendChild(el);
    }
    setup();
    const io = observers[observers.length - 1];
    act(() => io.cross("tables", true));
    const ask = screen.getByRole("button", { name: "Go to Ask the Lab" });
    fireEvent.click(ask);
    // The page settles with the tables under the middle of the window: the clicked jar still wins.
    expect(ask).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Go to Tables" })).not.toHaveAttribute("aria-current");
    // A key that is not a scroll key keeps it; a wheel turn releases it.
    fireEvent.keyDown(window, { key: "Tab" });
    expect(ask).toHaveAttribute("aria-current", "true");
    fireEvent.wheel(window);
    expect(screen.getByRole("button", { name: "Go to Tables" })).toHaveAttribute("aria-current", "true");
    expect(ask).not.toHaveAttribute("aria-current");
  });

  it("drains the jars of sections that go away (not interactive), then removes them", () => {
    vi.useFakeTimers();
    const { view, update } = setup();
    update({ tables: [] });
    expect(names(view.container)).toEqual(["Go to Intake"]);
    const leaving = view.container.querySelectorAll(".shelf-item--leaving");
    expect(leaving).toHaveLength(2);
    for (const el of leaving) expect(el).toHaveAttribute("aria-hidden", "true");
    expect(view.container.querySelector(".shelf-coil--powered")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(JAR_LEAVE_MS + 50);
    });
    expect(view.container.querySelectorAll(".shelf-item")).toHaveLength(1);
  });

  it("the coil arcs big on the wake strike and sparks on Confirm & stitch", () => {
    const { view } = setup();
    publish({ type: "wake" }, 1);
    expect(view.container.querySelectorAll(".shelf-arc--big")).toHaveLength(1);
    rest();
    expect(view.container.querySelector(".shelf-arc--big")).toBeNull();
    publish({ type: "confirm-stitch" }, 2);
    expect(view.container.querySelector(".shelf-arc--spark")).not.toBeNull();
  });

  it("dances with static (2 to 3 tiny arcs) while Frank is alive, redrawn every 300 to 600ms; off when asleep, calm or reduced", () => {
    vi.useFakeTimers();
    const first = setup();
    const arcs = () => first.view.container.querySelectorAll('[data-testid="shelf-static"] polyline');
    expect(arcs().length).toBeGreaterThanOrEqual(2);
    expect(arcs().length).toBeLessThanOrEqual(3);
    const before = Array.from(arcs()).map((p) => p.getAttribute("points")).join("|");
    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(Array.from(arcs()).map((p) => p.getAttribute("points")).join("|")).not.toBe(before);
    // Asleep from idling: off.
    rest(false, true);
    expect(first.view.container.querySelector('[data-testid="shelf-static"]')).toBeNull();
    rest(false, false);
    expect(first.view.container.querySelector('[data-testid="shelf-static"]')).not.toBeNull();
    // Calm Frank: off.
    rest(true, false);
    expect(first.view.container.querySelector('[data-testid="shelf-static"]')).toBeNull();
    first.view.unmount();
    // No tables (not alive): off.
    rest(false, false);
    const none = setup({ tables: [] });
    expect(none.view.container.querySelector('[data-testid="shelf-static"]')).toBeNull();
    none.view.unmount();
    // Reduced motion: off.
    reduced = true;
    mockMedia();
    const rm = setup();
    expect(rm.view.container.querySelector('[data-testid="shelf-static"]')).toBeNull();
  });

  it("under Calm Frank or reduced motion: static jars, no bubbles, no arcs", () => {
    const calm = setup();
    publish({ type: "wake" }, 5, true);
    expect(calm.view.container.querySelector(".lab-shelf--still")).not.toBeNull();
    expect(calm.view.container.querySelector(".shelf-arc")).toBeNull();
    expect(calm.view.container.querySelector(".shelf-jar__bubble")).toBeNull();
    calm.view.unmount();
    rest(false, false);
    reduced = true;
    mockMedia();
    const rm = setup();
    publish({ type: "wake" }, 6);
    expect(rm.view.container.querySelector(".shelf-arc")).toBeNull();
    expect(rm.view.container.querySelector(".shelf-jar__bubble")).toBeNull();
  });

  it("has rising bubbles in a jar that has liquid when motion is allowed, and none in an empty one", () => {
    const { view } = setup();
    const intake = view.container.querySelector('button[data-section="intake"]')!;
    expect(within(intake as HTMLElement).queryAllByText("", { selector: "circle" }).length).toBeGreaterThanOrEqual(0);
    expect(intake.querySelectorAll(".shelf-jar__bubble").length).toBeGreaterThanOrEqual(3);
    view.unmount();
    const empty = setup({ tables: [] });
    expect(empty.view.container.querySelectorAll(".shelf-jar__bubble")).toHaveLength(0);
  });

  it("crackles faintly while powered, never more often than every 20 seconds", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { view } = setup();
    act(() => {
      vi.advanceTimersByTime(19_999);
    });
    expect(view.container.querySelector(".shelf-arc--crackle")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(view.container.querySelector(".shelf-arc--crackle")).not.toBeNull();
    vi.restoreAllMocks();
  });
});
