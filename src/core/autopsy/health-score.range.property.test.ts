/**
 * Property-based test for the Autopsy health score range.
 *
 * Feature: frankendata-autopsy, Property 1: HealthScore is always an integer
 * between 0 and 100.
 *
 * Validates: Requirements 4.1, 9.1
 *
 * For arbitrary report inputs, including extreme, negative, and non-finite
 * numbers, `computeHealth` returns an integer score in [0, 100] and every
 * breakdown entry has positive integer points.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeHealth, type HealthColumn } from "./health-score";

const anyNumber = fc.oneof(
  fc.double({ noNaN: false }),
  fc.integer({ min: -1000, max: 1_000_000 })
);

const columnArb: fc.Arbitrary<HealthColumn> = fc.record({
  nullPct: anyNumber,
  whitespaceRows: fc.option(anyNumber, { nil: undefined }),
  caseVariantGroups: fc.option(anyNumber, { nil: undefined }),
  categoryVariants: fc.option(anyNumber, { nil: undefined }),
  outliers: fc.option(
    fc.record({
      count: anyNumber,
      lower: fc.double(),
      upper: fc.double(),
      examples: fc.constant([] as number[]),
    }),
    { nil: undefined }
  ),
});

describe("Property 1: HealthScore is an integer in 0 to 100", () => {
  it("holds for arbitrary inputs", () => {
    fc.assert(
      fc.property(
        anyNumber,
        anyNumber,
        fc.array(columnArb, { maxLength: 30 }),
        anyNumber,
        anyNumber,
        (rows, duplicateRows, columns, allNullColumns, constantColumns) => {
          const r = computeHealth({
            rows,
            duplicateRows,
            columns,
            allNullColumns,
            constantColumns,
          });
          expect(Number.isInteger(r.score)).toBe(true);
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(100);
          for (const d of r.breakdown) {
            expect(Number.isInteger(d.points)).toBe(true);
            expect(d.points).toBeGreaterThan(0);
          }
        }
      )
    );
  });
});
