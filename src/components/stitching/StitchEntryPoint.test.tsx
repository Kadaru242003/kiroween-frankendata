/**
 * Tests for the Stitch entry point gating (Feature 2, task 13).
 *
 * The entry point must be visible ONLY when two or more tables are loaded and
 * hidden otherwise (design "Fewer than two tables").
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  StitchEntryPoint,
  shouldShowStitchEntry,
} from "./StitchEntryPoint";

describe("shouldShowStitchEntry", () => {
  it("is hidden for fewer than two tables", () => {
    expect(shouldShowStitchEntry(0)).toBe(false);
    expect(shouldShowStitchEntry(1)).toBe(false);
  });

  it("is shown for two or more tables", () => {
    expect(shouldShowStitchEntry(2)).toBe(true);
    expect(shouldShowStitchEntry(5)).toBe(true);
  });
});

describe("StitchEntryPoint", () => {
  it("renders nothing with fewer than two tables", () => {
    const { container } = render(
      <StitchEntryPoint tableCount={1} onOpen={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("button", { name: "Stitch tables" })
    ).not.toBeInTheDocument();
  });

  it("renders the Stitch button with two or more tables and fires onOpen", () => {
    const onOpen = vi.fn();
    render(<StitchEntryPoint tableCount={2} onOpen={onOpen} />);
    const button = screen.getByRole("button", { name: "Stitch tables" });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
