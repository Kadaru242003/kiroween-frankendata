/**
 * Feature: ui-polish, canonical tie-break: the chosen canonical is always one
 * of the observed variants, is a maximum-frequency variant, and among those
 * never has a worse case shape than another candidate.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { caseShapeRank, mostFrequentSurfaceForm } from "./cleaning-rules";

const entries = fc
  .array(fc.record({ value: fc.string({ maxLength: 12 }), count: fc.integer({ min: 1, max: 4 }) }), { minLength: 1, maxLength: 8 })
  .map((xs) => {
    const seen = new Set<string>();
    return xs.filter((x) => (seen.has(x.value) ? false : (seen.add(x.value), true)));
  })
  .filter((xs) => xs.length > 0);

describe("canonical tie-break property", () => {
  it("is always an observed, most frequent, best-shaped variant", () => {
    fc.assert(
      fc.property(entries, (xs) => {
        const chosen = mostFrequentSurfaceForm(xs);
        expect(xs.map((x) => x.value)).toContain(chosen);
        const max = Math.max(...xs.map((x) => x.count));
        const top = xs.filter((x) => x.count === max);
        expect(top.map((x) => x.value)).toContain(chosen);
        const bestRank = Math.min(...top.map((x) => caseShapeRank(x.value)));
        expect(caseShapeRank(chosen)).toBe(bestRank);
      }),
      { numRuns: 300 }
    );
  });
});
