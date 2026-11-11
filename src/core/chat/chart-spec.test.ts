/**
 * Unit tests for ChartSpec validation + category shaping (Feature 3, task 10).
 *
 * Covers design "ChartSpec validation" / "Charts" and Requirements 5.8, 8.3:
 * accept a valid bar spec, drop invalid specs (unknown type, missing column,
 * non-numeric y, x === y), treat valid line/pie as "no chart" for now without
 * failing, and cap categories (truncate for bar, "Other" for pie).
 */

import { describe, expect, it } from "vitest";
import { validateChartSpec, shapeCategories } from "./chart-spec";
import { ASK_CHART_MAX_CATEGORIES, type DisplayValue } from "./types";

const cols = ["species", "count"];
const rows: DisplayValue[][] = [
  ["ghost", 3],
  ["vamp", 1],
];

describe("validateChartSpec", () => {
  it("keeps a valid bar chart (numeric y)", () => {
    expect(validateChartSpec({ type: "bar", x: "species", y: "count" }, cols, rows)).toEqual({
      type: "bar",
      x: "species",
      y: "count",
    });
  });

  it("drops a chart whose x column is missing", () => {
    expect(validateChartSpec({ type: "bar", x: "nope", y: "count" }, cols, rows)).toBeUndefined();
  });

  it("drops a chart whose y column is missing", () => {
    expect(validateChartSpec({ type: "bar", x: "species", y: "nope" }, cols, rows)).toBeUndefined();
  });

  it("drops a chart whose y column is not numeric", () => {
    const strRows: DisplayValue[][] = [["a", "b"]];
    expect(validateChartSpec({ type: "bar", x: "species", y: "count" }, cols, strRows)).toBeUndefined();
  });

  it("drops a chart where x === y", () => {
    expect(validateChartSpec({ type: "bar", x: "count", y: "count" }, cols, rows)).toBeUndefined();
  });

  it("drops a chart with an unknown type", () => {
    expect(
      validateChartSpec(
        { type: "scatter" as unknown as "bar", x: "species", y: "count" },
        cols,
        rows
      )
    ).toBeUndefined();
  });

  it("treats a valid line/pie spec as 'no chart' for now without failing", () => {
    // renderableOnly (default) → line/pie are dropped (optional task adds them).
    expect(validateChartSpec({ type: "line", x: "species", y: "count" }, cols, rows)).toBeUndefined();
    expect(validateChartSpec({ type: "pie", x: "species", y: "count" }, cols, rows)).toBeUndefined();
    // With renderableOnly=false, the SHAPE is valid (so they are recognized).
    expect(
      validateChartSpec({ type: "pie", x: "species", y: "count" }, cols, rows, {
        renderableOnly: false,
      })
    ).toEqual({ type: "pie", x: "species", y: "count" });
  });

  it("drops the chart for an empty result (not a numeric column)", () => {
    expect(validateChartSpec({ type: "bar", x: "species", y: "count" }, cols, [])).toBeUndefined();
  });

  it("returns undefined for an absent spec", () => {
    expect(validateChartSpec(undefined, cols, rows)).toBeUndefined();
  });
});

describe("shapeCategories", () => {
  it("returns all categories when under the cap", () => {
    const out = shapeCategories("bar", cols, rows, "species", "count");
    expect(out).toEqual([
      { label: "ghost", value: 3 },
      { label: "vamp", value: 1 },
    ]);
  });

  it("truncates a bar chart to ASK_CHART_MAX_CATEGORIES", () => {
    const many: DisplayValue[][] = Array.from(
      { length: ASK_CHART_MAX_CATEGORIES + 5 },
      (_, i) => [`c${i}`, i + 1]
    );
    const out = shapeCategories("bar", cols, many, "species", "count");
    expect(out).toHaveLength(ASK_CHART_MAX_CATEGORIES);
    expect(out[0].label).toBe("c0");
  });

  it("sums the overflow into an 'Other' slice for a pie chart", () => {
    const n = ASK_CHART_MAX_CATEGORIES + 3;
    const many: DisplayValue[][] = Array.from({ length: n }, (_, i) => [`c${i}`, 1]);
    const out = shapeCategories("pie", cols, many, "species", "count");
    expect(out).toHaveLength(ASK_CHART_MAX_CATEGORIES);
    expect(out[out.length - 1].label).toBe("Other");
    // Overflow slices (n - (max-1)) each value 1 → summed.
    expect(out[out.length - 1].value).toBe(n - (ASK_CHART_MAX_CATEGORIES - 1));
    // Total value is preserved.
    expect(out.reduce((s, d) => s + d.value, 0)).toBe(n);
  });

  it("coerces non-numeric y cells to 0 and stringifies labels", () => {
    const mixed: DisplayValue[][] = [
      [true, 2],
      ["x", "nope" as unknown as number],
    ];
    const out = shapeCategories("bar", cols, mixed, "species", "count");
    expect(out).toEqual([
      { label: "true", value: 2 },
      { label: "x", value: 0 },
    ]);
  });
});
