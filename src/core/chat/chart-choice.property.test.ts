/**
 * Feature: frankendata-smarter-ask, Property 3: chart choice is deterministic,
 * independent of set order, a line only for temporal plus numeric and a bar
 * only for text plus numeric.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chooseChart, isNumericColumn } from "./chart-choice";
import type { DisplayValue } from "./types";

const cell: fc.Arbitrary<DisplayValue> = fc.oneof(fc.string({ maxLength: 8 }), fc.integer({ min: -50, max: 50 }), fc.boolean());

describe("Feature: frankendata-smarter-ask, Property 3: chart choice", () => {
  it("is deterministic and follows the rules", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 4 }),
        fc.array(fc.array(cell, { minLength: 4, maxLength: 4 }), { maxLength: 6 }),
        fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 4 }),
        (columns, rows4, temporalList) => {
          const rows = rows4.map((r) => r.slice(0, columns.length));
          const t1 = new Set<string>(temporalList);
          const t2 = new Set<string>([...temporalList].reverse());
          const one = chooseChart(columns, rows, t1);
          expect(chooseChart(columns, rows, t1)).toEqual(one);
          expect(chooseChart(columns, rows, t2)).toEqual(one);
          if (one === undefined) return;
          expect(columns).toHaveLength(2);
          const xi = columns.indexOf(one.x);
          const yi = columns.indexOf(one.y);
          expect(isNumericColumn(rows, columns[0] === one.y ? 0 : 1)).toBe(true);
          expect(xi).not.toBe(yi);
          if (one.type === "line") expect(t1.has(one.x)).toBe(true);
          if (one.type === "bar") {
            expect(t1.has(one.x)).toBe(false);
            expect(t1.has(one.y)).toBe(false);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});
