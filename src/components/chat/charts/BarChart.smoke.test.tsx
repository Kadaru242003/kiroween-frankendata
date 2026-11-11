/**
 * Smoke test for the hand-built BarChart SVG (Feature 3, task 10).
 *
 * Confirms it renders bars for a validated bar spec, labels categories/values
 * as plain text, truncates a long x label while keeping the full text in a
 * <title> tooltip, and renders nothing for empty data.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarChart } from "./BarChart";
import type { ChartSpec, DisplayValue } from "../../../core/chat/types";

const spec: ChartSpec = { type: "bar", x: "species", y: "count" };
const cols = ["species", "count"];

describe("BarChart", () => {
  it("renders one bar per category with plain-text value labels", () => {
    const rows: DisplayValue[][] = [
      ["ghost", 3],
      ["vamp", 1],
    ];
    const { container } = render(<BarChart spec={spec} columns={cols} rows={rows} />);
    expect(container.querySelectorAll("rect.ask-chart__bar")).toHaveLength(2);
    // Category labels are plain text.
    expect(container.textContent).toContain("ghost");
    expect(container.textContent).toContain("vamp");
  });

  it("truncates a long x label but keeps the full text in a <title>", () => {
    const rows: DisplayValue[][] = [["a-very-long-category-name", 5]];
    const { container } = render(<BarChart spec={spec} columns={cols} rows={rows} />);
    const titles = Array.from(container.querySelectorAll("title")).map((t) => t.textContent);
    expect(titles).toContain("a-very-long-category-name");
    // The visible x label is truncated with an ellipsis.
    expect(container.textContent).toContain("…");
  });

  it("renders nothing for empty data", () => {
    const { container } = render(<BarChart spec={spec} columns={cols} rows={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
