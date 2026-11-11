/**
 * Property-based tests for percent-to-decimal conversion in value coercion.
 *
 * Feature: frankendata-file-intake, Property 14: Percent-to-decimal conversion
 *
 * Validates: Requirements 5.5
 *
 * Property 14 statement: For any number value with a trailing percent sign, the
 * converted value equals the numeric portion divided by 100 (e.g. `12%` becomes
 * `0.12`).
 *
 * The function under test is {@link parseNumber} from `./coercion`, which strips
 * surrounding whitespace, a leading currency symbol/word, and thousands-
 * separator commas, and converts a trailing percent sign to its decimal
 * fraction. These tests focus solely on the trailing-percent → divide-by-100
 * behavior.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseNumber } from "./coercion";

const NUM_RUNS = 200;

/**
 * Generate finite numeric values with a bounded magnitude and a limited number
 * of decimal places. Keeping the values to a few decimals minimizes
 * floating-point representation error so the divide-by-100 assertion is stable,
 * while still covering positive, negative, zero, integer, and fractional cases.
 *
 * `fc.double` is restricted to a sane finite range (no NaN/Infinity) and each
 * draw is rounded to at most 4 decimal places before being used as the numeric
 * portion of a percent string.
 */
const numericValue = fc
  .double({ min: -1_000_000, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
  .map((n) => Math.round(n * 10_000) / 10_000);

/** Optional surrounding whitespace, exercising the leading/trailing trim. */
const whitespace = fc.constantFrom("", " ", "  ", "\t", " \t ");

/**
 * Assert approximate equality with a relative tolerance, so ordinary
 * floating-point rounding from the divide-by-100 does not cause flakiness.
 */
function approxEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

describe("parseNumber percent-to-decimal conversion (Property 14)", () => {
  it("divides the numeric portion of a trailing-percent value by 100", () => {
    fc.assert(
      fc.property(numericValue, (n) => {
        const result = parseNumber(`${n}%`);
        return approxEqual(result, n / 100);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("ignores surrounding whitespace around a trailing-percent value", () => {
    fc.assert(
      fc.property(numericValue, whitespace, whitespace, (n, lead, trail) => {
        const result = parseNumber(`${lead}${n}%${trail}`);
        return approxEqual(result, n / 100);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("converts the canonical example 12% to 0.12", () => {
    expect(parseNumber("12%")).toBeCloseTo(0.12, 10);
  });
});
