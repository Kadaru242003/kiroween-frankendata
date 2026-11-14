import { afterEach, describe, expect, it, vi } from "vitest";
import { revealProposalCard } from "./reveal-proposal";

describe("revealProposalCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });
  it("scrolls the approval screen, focuses and highlights the card", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<section class="approval-screen"><article id="proposal-card-p1" tabindex="-1"></article></section>';
    const screenEl = document.querySelector(".approval-screen") as HTMLElement;
    const scroll = vi.fn();
    screenEl.scrollIntoView = scroll;
    revealProposalCard("p1");
    vi.advanceTimersByTime(10);
    const card = document.getElementById("proposal-card-p1")!;
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(card);
    expect(card.classList.contains("stitch-proposal--flash")).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(card.classList.contains("stitch-proposal--flash")).toBe(false);
  });
});
