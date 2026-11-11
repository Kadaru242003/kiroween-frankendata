/**
 * Minimal render smoke test for DropZone (task 15.1).
 *
 * Confirms the component renders the intake-port region, toggles its drag-over
 * highlight on drag events, forwards dropped files to `onFiles`, and shows the
 * guidance message only when the dropped count is outside the 2–4 range. The
 * exhaustive property test for the guidance message is task 15.2.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DropZone,
  FILE_COUNT_GUIDANCE_MESSAGE,
  isOutsideIntendedRange,
} from "./DropZone";

/** Build a drop event payload carrying the given files on `dataTransfer`. */
function dataTransferWith(files: File[]): { dataTransfer: { files: File[] } } {
  return { dataTransfer: { files } };
}

describe("isOutsideIntendedRange", () => {
  it("is false within 2..4 and for an empty drop, true otherwise", () => {
    expect(isOutsideIntendedRange(0)).toBe(false);
    expect(isOutsideIntendedRange(1)).toBe(true);
    expect(isOutsideIntendedRange(2)).toBe(false);
    expect(isOutsideIntendedRange(3)).toBe(false);
    expect(isOutsideIntendedRange(4)).toBe(false);
    expect(isOutsideIntendedRange(5)).toBe(true);
  });
});

describe("DropZone", () => {
  it("renders the intake-port region", () => {
    render(<DropZone onFiles={() => {}} />);
    expect(
      screen.getByRole("button", { name: /file intake port/i })
    ).toBeInTheDocument();
  });

  it("highlights on drag-over and clears on drag-leave", () => {
    render(<DropZone onFiles={() => {}} />);
    const zone = screen.getByRole("button", { name: /file intake port/i });

    fireEvent.dragOver(zone);
    expect(zone).toHaveAttribute("data-dragging", "true");

    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute("data-dragging", "false");
  });

  it("forwards every dropped file regardless of count", () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole("button", { name: /file intake port/i });

    const files = [
      new File(["a"], "a.csv"),
      new File(["b"], "b.csv"),
      new File(["c"], "c.csv"),
    ];
    fireEvent.drop(zone, dataTransferWith(files));

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0]).toHaveLength(3);
  });

  it("shows guidance when the dropped count is outside 2..4", () => {
    render(<DropZone onFiles={() => {}} />);
    const zone = screen.getByRole("button", { name: /file intake port/i });

    fireEvent.drop(zone, dataTransferWith([new File(["a"], "a.csv")]));
    expect(screen.getByText(FILE_COUNT_GUIDANCE_MESSAGE)).toBeInTheDocument();
  });

  it("does not show guidance when the dropped count is within 2..4", () => {
    render(<DropZone onFiles={() => {}} />);
    const zone = screen.getByRole("button", { name: /file intake port/i });

    fireEvent.drop(
      zone,
      dataTransferWith([new File(["a"], "a.csv"), new File(["b"], "b.csv")])
    );
    expect(screen.queryByText(FILE_COUNT_GUIDANCE_MESSAGE)).not.toBeInTheDocument();
  });
});
