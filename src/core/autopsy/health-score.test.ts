/**
 * Unit tests for the Autopsy health score and column status (Feature 4, task 2).
 * Requirements 4.1 to 4.4.
 */

import { describe, expect, it } from "vitest";
import { columnStatus, computeHealth, type HealthColumn } from "./health-score";

const clean: HealthColumn = { nullPct: 0 };

describe("computeHealth", () => {
  it("scores a clean table 100 with an empty breakdown", () => {
    const r = computeHealth({
      rows: 10,
      duplicateRows: 0,
      columns: [clean, clean],
      allNullColumns: 0,
      constantColumns: 0,
    });
    expect(r).toEqual({ score: 100, breakdown: [] });
  });

  it("reproduces the worked example from the design (score 81)", () => {
    // monsters: 14 rows, 2 duplicates, one whitespace column, one case-variant column.
    const r = computeHealth({
      rows: 14,
      duplicateRows: 2,
      columns: [
        clean,
        { nullPct: 0, whitespaceRows: 1, caseVariantGroups: 2 },
        clean,
        clean,
      ],
      allNullColumns: 0,
      constantColumns: 0,
    });
    expect(r.score).toBe(81);
    const byCode = Object.fromEntries(r.breakdown.map((d) => [d.code, d.points]));
    expect(byCode).toEqual({ duplicates: 14, whitespace: 2, variants: 3 });
  });

  it("breakdown points sum to 100 minus the score when not clamped", () => {
    const r = computeHealth({
      rows: 100,
      duplicateRows: 5,
      columns: [{ nullPct: 20 }, { nullPct: 0, outliers: { count: 2, lower: 0, upper: 1, examples: [] } }],
      allNullColumns: 0,
      constantColumns: 1,
    });
    const sum = r.breakdown.reduce((s, d) => s + d.points, 0);
    expect(100 - sum).toBe(r.score);
  });

  it("caps each category", () => {
    const many = Array.from({ length: 20 }, () => ({
      nullPct: 100,
      whitespaceRows: 1,
      caseVariantGroups: 1,
      outliers: { count: 1, lower: 0, upper: 1, examples: [] },
    }));
    const r = computeHealth({
      rows: 10,
      duplicateRows: 10,
      columns: many,
      allNullColumns: 20,
      constantColumns: 20,
    });
    const byCode = Object.fromEntries(r.breakdown.map((d) => [d.code, d.points]));
    expect(byCode).toEqual({
      duplicates: 20,
      nulls: 25,
      "all-null": 15,
      constant: 6,
      whitespace: 10,
      variants: 15,
      outliers: 10,
    });
    // 101 total deduction clamps at 0.
    expect(r.score).toBe(0);
  });

  it("handles a table with zero rows and zero columns", () => {
    const r = computeHealth({
      rows: 0,
      duplicateRows: 0,
      columns: [],
      allNullColumns: 0,
      constantColumns: 0,
    });
    expect(r.score).toBe(100);
  });

  it("never reports more duplicates than rows", () => {
    const r = computeHealth({
      rows: 4,
      duplicateRows: 99,
      columns: [clean],
      allNullColumns: 0,
      constantColumns: 0,
    });
    expect(r.breakdown[0].reason).toContain("(4 of 4)");
  });
});

describe("columnStatus", () => {
  const base = { rows: 100, nullCount: 0, nullPct: 0, distinct: 50 };

  it("is healthy with no problems", () => {
    expect(columnStatus(base)).toEqual({ status: "healthy", reasons: [] });
  });

  it("warns at the null warning boundary and not below", () => {
    expect(columnStatus({ ...base, nullCount: 4, nullPct: 4.99 }).status).toBe("healthy");
    expect(columnStatus({ ...base, nullCount: 5, nullPct: 5 }).status).toBe("warning");
  });

  it("is critical at the null critical boundary", () => {
    expect(columnStatus({ ...base, nullCount: 49, nullPct: 49 }).status).toBe("warning");
    expect(columnStatus({ ...base, nullCount: 50, nullPct: 50 }).status).toBe("critical");
  });

  it("is critical when entirely empty", () => {
    const r = columnStatus({ rows: 10, nullCount: 10, nullPct: 100, distinct: 0 });
    expect(r.status).toBe("critical");
    expect(r.reasons[0]).toBe("Column is entirely empty");
  });

  it("warns for a constant column but not for a one-row table", () => {
    expect(columnStatus({ ...base, distinct: 1 }).status).toBe("warning");
    expect(columnStatus({ rows: 1, nullCount: 0, nullPct: 0, distinct: 1 }).status).toBe("healthy");
  });

  it("warns for whitespace, case, and category variants", () => {
    expect(columnStatus({ ...base, whitespaceRows: 1 }).status).toBe("warning");
    expect(columnStatus({ ...base, caseVariantGroups: 1 }).status).toBe("warning");
    expect(columnStatus({ ...base, categoryVariants: 2 }).status).toBe("warning");
  });

  it("warns for a few outliers and is critical at the outlier threshold", () => {
    const o = (count: number) => ({ count, lower: 0, upper: 1, examples: [] });
    expect(columnStatus({ ...base, outliers: o(1) }).status).toBe("warning");
    expect(columnStatus({ ...base, outliers: o(9) }).status).toBe("warning");
    expect(columnStatus({ ...base, outliers: o(10) }).status).toBe("critical");
  });
});
