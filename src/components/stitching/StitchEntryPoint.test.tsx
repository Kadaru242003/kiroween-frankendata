/**
 * Tests for the Stitch entry point gating + table selection (Feature 2, task
 * 13 + polish batch 2, item 1).
 *
 * - Visible ONLY when two or more tables are loaded (design "Fewer than two
 *   tables").
 * - A checkbox per table (all checked by default, driven by the parent).
 * - "Stitch tables" needs at least two CHECKED tables; disabled otherwise with
 *   a short hint.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  StitchEntryPoint,
  shouldShowStitchEntry,
  canStartStitching,
} from "./StitchEntryPoint";

const THREE_TABLES = [
  { tableName: "monsters" },
  { tableName: "experiments" },
  { tableName: "lab_inventory" },
];

function allChecked(names: readonly { tableName: string }[]): Set<string> {
  return new Set(names.map((t) => t.tableName));
}

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

describe("canStartStitching", () => {
  it("requires at least two checked tables", () => {
    expect(canStartStitching(0)).toBe(false);
    expect(canStartStitching(1)).toBe(false);
    expect(canStartStitching(2)).toBe(true);
    expect(canStartStitching(3)).toBe(true);
  });
});

describe("StitchEntryPoint", () => {
  it("renders nothing with fewer than two tables", () => {
    const { container } = render(
      <StitchEntryPoint
        tables={[{ tableName: "monsters" }]}
        selectedTableNames={new Set(["monsters"])}
        onToggleTable={vi.fn()}
        onOpen={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("button", { name: "Stitch tables" })
    ).not.toBeInTheDocument();
  });

  it("renders a checked checkbox per table with two or more tables", () => {
    render(
      <StitchEntryPoint
        tables={THREE_TABLES}
        selectedTableNames={allChecked(THREE_TABLES)}
        onToggleTable={vi.fn()}
        onOpen={vi.fn()}
      />
    );
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes.every((c) => c.checked)).toBe(true);
    expect(screen.getByText("monsters")).toBeInTheDocument();
  });

  it("reports a toggle through onToggleTable", () => {
    const onToggleTable = vi.fn();
    render(
      <StitchEntryPoint
        tables={THREE_TABLES}
        selectedTableNames={allChecked(THREE_TABLES)}
        onToggleTable={onToggleTable}
        onOpen={vi.fn()}
      />
    );
    // Uncheck the lab_inventory checkbox (its label text is the table name).
    const labCheckbox = screen.getByRole("checkbox", { name: /lab_inventory/ });
    fireEvent.click(labCheckbox);
    expect(onToggleTable).toHaveBeenCalledWith("lab_inventory", false);
  });

  it("enables the button and fires onOpen when >= 2 tables are checked", () => {
    const onOpen = vi.fn();
    render(
      <StitchEntryPoint
        tables={THREE_TABLES}
        selectedTableNames={new Set(["monsters", "experiments"])}
        onToggleTable={vi.fn()}
        onOpen={onOpen}
      />
    );
    const button = screen.getByRole("button", { name: "Stitch tables" });
    expect(button).toBeEnabled();
    expect(
      screen.queryByText("Check at least two tables to stitch.")
    ).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("disables the button with a hint when fewer than 2 tables are checked", () => {
    render(
      <StitchEntryPoint
        tables={THREE_TABLES}
        selectedTableNames={new Set(["monsters"])}
        onToggleTable={vi.fn()}
        onOpen={vi.fn()}
      />
    );
    const button = screen.getByRole("button", { name: "Stitch tables" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("Check at least two tables to stitch.")
    ).toBeInTheDocument();
  });
});
