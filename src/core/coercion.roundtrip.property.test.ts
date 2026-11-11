/**
 * Property-based test for the number format/parse round trip.
 *
 * Feature: frankendata-file-intake, Property 15: Number formatting round trip
 *
 * Validates: Requirements 10.7
 *
 * Property 15 statement: For any number, formatting it with a currency symbol,
 * thousands separators, or surrounding whitespace and then parsing it back
 * yields the same numeric value.
 *
 * The functions under test are {@link formatNumber} and {@link parseNumber}
 * from `./coercion`. `formatNumber` renders a number with its lossless
 * `Number.prototype.toString` form, optionally decorated with a recognized
 * currency prefix, thousands-separator commas (integer part only, skipped for
 * scientific-notation forms), and surrounding whitespace. `parseNumber`
 * strips exactly those decorations, so the contract guarantees the round trip
 * is EXACT: `parseNumber(formatNumber(n, opts)) === n`. These tests assert
 * that exact equality (no tolerance needed), using only option combinations
 * the contract supports:
 *   - currency, when present, must be one of the prefixes `parseNumber`
 *     recognizes (`$`, `€`, `£`, `₹`, `EUR`, `GBP`, `INR`);
 *   - whitespace must be trim-removable whitespace (spaces/tabs/newlines).
 *
 * Percent output is intentionally out of scope: `formatNumber` does not emit
 * a percent sign because the percent round trip can lose precision, so these
 * tests never exercise it.
 *
 * Equality note: the property is phrased in terms of the "same numeric value",
 * i.e. JavaScript's `===`, under which `-0 === +0` is `true`. We assert with
 * `===` rather than `Object.is`/`toBe` because the decimal string form
 * `formatNumber` emits (`Number.prototype.toString`) renders both `-0` and
 * `+0` as `"0"`: negative zero has no distinct decimal representation, so
 * `parseNumber` recovers `+0`. This is not a precision loss — `-0` and `+0`
 * are the same numeric value — so `===` is the correct, exact equality for the
 * contract, and it still distinguishes every other pair of numbers exactly.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  formatNumber,
  parseNumber,
  type FormatNumberOptions,
} from "./coercion";

const NUM_RUNS = 200;

/** Currency prefixes `parseNumber` recognizes; `undefined` = no currency. */
const CURRENCY_PREFIXES = ["$", "€", "£", "₹", "EUR", "GBP", "INR"] as const;

/**
 * Finite-number generator. We exclude NaN and ±Infinity (they are not numeric
 * values the coercion contract round-trips) and keep `noDefaultInfinity` so
 * fast-check never produces them. `toString()` renders every finite double
 * losslessly, so the whole finite double range round-trips; we deliberately
 * include values whose `toString()` is scientific notation (very large/small
 * magnitudes) because the contract still holds for them (thousands grouping is
 * skipped for those, leaving the parsable form intact).
 */
const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true });

/** Trim-removable whitespace strings (including the empty "no whitespace"). */
const whitespace = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
    minLength: 0,
    maxLength: 4,
  })
  .map((chars) => chars.join(""));

/**
 * Arbitrary FormatNumberOptions: currency present or absent (and which
 * symbol), thousands separators on/off, and surrounding whitespace on/off.
 */
const options: fc.Arbitrary<FormatNumberOptions> = fc.record({
  currency: fc.option(fc.constantFrom(...CURRENCY_PREFIXES), {
    nil: undefined,
  }),
  thousands: fc.boolean(),
  whitespace,
});

describe("Property 15: Number formatting round trip", () => {
  it("parseNumber(formatNumber(n, opts)) === n for arbitrary numbers and option combinations", () => {
    fc.assert(
      fc.property(finiteNumber, options, (n, opts) => {
        const formatted = formatNumber(n, opts);
        // `===` numeric equality (not Object.is): `-0 === +0`, matching the
        // "same numeric value" wording of the property.
        expect(parseNumber(formatted) === n).toBe(true);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("round-trips with every single decoration applied in isolation", () => {
    fc.assert(
      fc.property(finiteNumber, (n) => {
        // No decorations.
        expect(parseNumber(formatNumber(n)) === n).toBe(true);
        // Thousands separators only.
        expect(parseNumber(formatNumber(n, { thousands: true })) === n).toBe(
          true
        );
        // Surrounding whitespace only.
        expect(parseNumber(formatNumber(n, { whitespace: "  " })) === n).toBe(
          true
        );
        // Each recognized currency prefix only.
        for (const currency of CURRENCY_PREFIXES) {
          expect(parseNumber(formatNumber(n, { currency })) === n).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
