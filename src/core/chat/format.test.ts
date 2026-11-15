import { describe, expect, it } from "vitest";
import { formatCell, formatNumber, humanize, isNumericColumnAt, wrapLabel } from "./format";

describe("formatNumber", () => {
  it("uses thousands separators and at most 2 decimals", () => {
    expect(formatNumber(105200.4)).toBe("105,200.40");
    expect(formatNumber(34220)).toBe("34,220");
    expect(formatNumber(0.5)).toBe("0.50");
    expect(formatNumber(1234.5678)).toBe("1,234.57");
    expect(formatNumber(-1500)).toBe("-1,500");
    expect(formatNumber(Number.NaN)).toBe("");
  });
  it("formats cells", () => {
    expect(formatCell(1000)).toBe("1,000");
    expect(formatCell("1000")).toBe("1000");
    expect(formatCell(true)).toBe("true");
  });
});
describe("humanize", () => {
  it("turns snake_case into sentence case", () => {
    expect(humanize("invoiced_revenue")).toBe("Invoiced revenue");
    expect(humanize("Monthly_Revenue")).toBe("Monthly revenue");
    expect(humanize("region")).toBe("Region");
    expect(humanize("EMEA_total")).toBe("EMEA total");
    expect(humanize("")).toBe("");
  });
});
describe("isNumericColumnAt and wrapLabel", () => {
  it("detects numeric columns by the first non-empty value", () => {
    expect(isNumericColumnAt([["a", ""], ["b", 2]], 1)).toBe(true);
    expect(isNumericColumnAt([["a", 1]], 0)).toBe(false);
  });
  it("wraps to two lines then truncates", () => {
    expect(wrapLabel("North America", 20)).toEqual(["North America"]);
    expect(wrapLabel("North America", 8)).toEqual(["North", "America"]);
    const l = wrapLabel("Extraordinarily long category label here", 10);
    expect(l).toHaveLength(2);
    expect(l[1].endsWith("…")).toBe(true);
  });
});
