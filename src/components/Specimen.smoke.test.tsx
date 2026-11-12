/**
 * Smoke test for the Specimen mascot.
 *
 * Confirms it renders as a real "Poke the Specimen" button (keyboard reachable),
 * shows the asleep pose with no tables and the awake pose with tables, wears
 * bandages (the alive kit) when a stitched result exists, holds a bar-chart
 * sign when an Ask result is shown, and does not throw when poked.
 */

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Specimen, type SpecimenProps } from "./Specimen";

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

describe("Specimen", () => {
  it("renders a 'Poke the Specimen' button with aria-hidden body art", () => {
    const { getByRole, container } = renderSpecimen();
    const button = getByRole("button", { name: "Poke the Specimen" });
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

  it("holds a bar-chart sign when an Ask result is shown", () => {
    const { container } = renderSpecimen({ tableCount: 2, askResult: true });
    expect(container.querySelector(".specimen__sign")).not.toBeNull();
  });

  it("does not throw when poked", () => {
    const { getByRole } = renderSpecimen({ tableCount: 2 });
    const button = getByRole("button", { name: "Poke the Specimen" });
    expect(() => fireEvent.click(button)).not.toThrow();
  });
});
