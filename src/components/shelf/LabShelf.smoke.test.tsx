import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactionFor } from "../../core/frank/reactions";
import { StitchStore } from "../../core/stitching/stitch-store";
import type { LoadedTable } from "../../core/types";
import { frankFeed } from "../../state/frank-feed";
import { JAR_LEAVE_MS, LabShelf } from "./LabShelf";

const table = (tableName: string, rowCount: number) => ({ tableName, rowCount }) as unknown as LoadedTable;
const two = [table("crm_customers", 24), table("billing_invoices", 24)];

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
const publish = (id: Parameters<typeof reactionFor>[0], seq: number, calm = false) =>
  act(() => frankFeed.publish({ reaction: reactionFor(id), seq, calm }));
const idle = (calm = false) => act(() => frankFeed.publish({ reaction: null, seq: 0, calm }));

describe("LabShelf", () => {
  beforeEach(() => {
    wide = true;
    reduced = false;
    mockMedia();
    idle(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("is not rendered below 1440px", () => {
    wide = false;
    mockMedia();
    const { container } = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    expect(container.querySelector(".lab-shelf")).toBeNull();
  });

  it("shows one jar button per table with its name and row count, and the coil", () => {
    const { container } = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    expect(screen.getByRole("button", { name: "Go to table crm_customers, 24 rows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to table billing_invoices, 24 rows" })).toBeInTheDocument();
    expect(container.querySelector(".shelf-coil--powered")).not.toBeNull();
    // Long names are cut on the label, and the full name is the tooltip.
    const jar = screen.getByRole("button", { name: /billing_invoices/ });
    expect(jar).toHaveAttribute("title", "billing_invoices (24 rows)");
    expect(jar.querySelector(".shelf-jar__name")!.textContent).toBe("billing_inv\u2026");
    expect(jar.querySelector(".shelf-jar__rows")!.textContent).toBe("24 rows");
    // Everything but the jar buttons is hidden from assistive tech.
    expect(container.querySelector(".shelf-coil")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll(".shelf-jar__art")).toHaveLength(2);
    for (const art of container.querySelectorAll(".shelf-jar__art")) expect(art).toHaveAttribute("aria-hidden", "true");
  });

  it("gives a stitched result its own jar with stitched seams", () => {
    const store = new StitchStore();
    const { container } = render(<LabShelf tables={two} stitchStore={store} />);
    act(() => store.setApplied(table("stitch_1_result", 48) as never, { createdTableNames: [] }, { fannedOut: false } as never));
    expect(screen.getByRole("button", { name: "Go to table stitch_1_result, 48 rows" })).toBeInTheDocument();
    expect(container.querySelectorAll("button.shelf-jar")).toHaveLength(3);
    expect(container.querySelector(".shelf-jar--stitched .shelf-jar__label--stitched .shelf-jar__stitch")).not.toBeNull();
  });

  it("shows six jars and a +N jar for more than six tables", () => {
    const eight = Array.from({ length: 8 }, (_, i) => table(`t${i + 1}`, 5));
    const { container } = render(<LabShelf tables={eight} stitchStore={new StitchStore()} />);
    expect(container.querySelectorAll("button.shelf-jar")).toHaveLength(6);
    const more = container.querySelector(".shelf-jar--more")!;
    expect(more).toHaveAttribute("aria-hidden", "true");
    expect(more.textContent).toBe("+2");
  });

  it("scrolls the table's card into view (smoothly, or at once under reduced motion) and moves no focus", () => {
    const card = document.createElement("section");
    card.className = "table-preview-card";
    card.setAttribute("aria-label", "Preview of crm_customers");
    const scroll = vi.fn();
    card.scrollIntoView = scroll;
    document.body.appendChild(card);
    const { unmount } = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    const jar = screen.getByRole("button", { name: /crm_customers/ });
    fireEvent.click(jar);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    unmount();
    reduced = true;
    mockMedia();
    render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    fireEvent.click(screen.getByRole("button", { name: /crm_customers/ }));
    expect(scroll).toHaveBeenLastCalledWith({ behavior: "auto", block: "start" });
  });

  it("drains the jars on reset (not interactive while draining), then removes them", () => {
    vi.useFakeTimers();
    const store = new StitchStore();
    const { container, rerender } = render(<LabShelf tables={two} stitchStore={store} />);
    rerender(<LabShelf tables={[]} stitchStore={store} />);
    expect(container.querySelectorAll("button.shelf-jar")).toHaveLength(0);
    const leaving = container.querySelectorAll(".shelf-jar--leaving");
    expect(leaving).toHaveLength(2);
    for (const el of leaving) expect(el).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".shelf-coil--powered")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(JAR_LEAVE_MS + 50);
    });
    expect(container.querySelectorAll(".shelf-jar")).toHaveLength(0);
  });

  it("the coil arcs big on the wake strike and sparks on Confirm & stitch", () => {
    const { container } = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    expect(container.querySelector(".shelf-arc--big")).toBeNull();
    publish({ type: "wake" }, 1);
    expect(container.querySelectorAll(".shelf-arc--big")).toHaveLength(1);
    expect(container.querySelectorAll(".shelf-arc__core path").length).toBeGreaterThanOrEqual(3);
    idle();
    expect(container.querySelector(".shelf-arc--big")).toBeNull();
    publish({ type: "confirm-stitch" }, 2);
    expect(container.querySelector(".shelf-arc--spark")).not.toBeNull();
    expect(container.querySelector(".shelf-arc--big")).toBeNull();
  });

  it("under Calm Frank or reduced motion: static jars, no bubbles, no arcs", () => {
    const check = (container: HTMLElement) => {
      publish({ type: "wake" }, 5, true);
      expect(container.querySelector(".lab-shelf--still")).not.toBeNull();
      expect(container.querySelector(".shelf-arc")).toBeNull();
      expect(container.querySelector(".shelf-jar__bubble")).toBeNull();
      expect(container.querySelectorAll(".shelf-jar__liquid").length).toBe(2);
    };
    const calm = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    check(calm.container);
    calm.unmount();
    idle(false);
    reduced = true;
    mockMedia();
    const rm = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    expect(rm.container.querySelector(".shelf-jar__bubble")).toBeNull();
    publish({ type: "wake" }, 6);
    expect(rm.container.querySelector(".shelf-arc")).toBeNull();
  });

  it("has rising bubbles when motion is allowed", () => {
    const { container } = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    expect(container.querySelectorAll(".shelf-jar__bubble").length).toBeGreaterThanOrEqual(3);
  });

  it("crackles faintly while powered and idle, never more often than every 20 seconds", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { container } = render(<LabShelf tables={two} stitchStore={new StitchStore()} />);
    act(() => {
      vi.advanceTimersByTime(19_999);
    });
    expect(container.querySelector(".shelf-arc--crackle")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    const first = container.querySelector(".shelf-arc--crackle");
    expect(first).not.toBeNull();
    // Count crackles over two minutes: at most one per 20 seconds.
    let seen = 1;
    let last = container.querySelector(".shelf-arc--crackle");
    for (let t = 0; t < 120_000; t += 1000) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      const now = container.querySelector(".shelf-arc--crackle");
      if (now !== last) {
        seen += 1;
        last = now;
      }
    }
    expect(seen).toBeLessThanOrEqual(1 + 6);
    vi.restoreAllMocks();
  });

  it("does not crackle with no tables (unpowered)", () => {
    vi.useFakeTimers();
    const { container } = render(<LabShelf tables={[]} stitchStore={new StitchStore()} />);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(container.querySelector(".shelf-arc--crackle")).toBeNull();
    expect(container.querySelector(".shelf-coil--powered")).toBeNull();
  });
});
