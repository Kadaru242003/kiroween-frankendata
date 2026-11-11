/**
 * Property-based tests for all-numbers column inference.
 *
 * Feature: frankendata-file-intake, Property 13: All-numbers infer number
 * (including NullToken-mixed columns)
 *
 * Validates: Requirements 5.4, 10.3, 10.9
 *
 * Property 13 statement: For any column whose non-`NullToken` values all parse
 * as numbers — including currency symbols/words, thousands separators,
 * surrounding whitespace, and trailing percent signs — the inferred
 * `ColumnType` is `number`. This holds for columns that mix `NullToken`s with
 * numbers, because `NullToken` values are excluded before classification.
 *
 * The function under test is {@link TypeInferenceLayer.infer} from
 * `type-inference.ts` (exercised via the `typeInferenceLayer` singleton). The
 * table is built as a single column: `columnNames = ["col"]` and
 * `rows = values.map((v) => [v])`. The assertion is
 * `infer(columnNames, rows)[0].type === "number"`.
 *
 * The number-like string generator below is kept deliberately consistent with
 * `isNumber`/`parseNumericCore` in `predicates.ts` so every generated value is
 * actually accepted as a number:
 *   - accepted currency PREFIXES (one leading symbol/word): `$ € £ ₹` and the
 *     words `EUR` / `GBP` / `INR` (the word forms are matched case-insensitively
 *     by the predicate, but we emit them as-is to stay unambiguous);
 *   - thousands-separator commas are stripped before validation;
 *   - a single optional TRAILING percent sign;
 *   - surrounding whitespace is trimmed.
 * The numeric core is a finite decimal (optionally signed, optional fraction,
 * optional scientific exponent), matching the predicate's strict pattern. We
 * avoid ambiguous forms the predicate would reject (lone `-`, bare `.`, `NaN`,
 * `Infinity`, multiple prefixes, a leading-sign combined with a currency word,
 * etc.).
 *
 * NullTokens are generated to match `isNullToken`: empty / whitespace-only
 * strings, the JS value `null`, and the texts `N/A` / `NA` / `null` / `-`
 * (case-insensitive after trimming). At least one real number is always present
 * so the all-`NullToken` case (Property 19 / task 7.11) never sneaks in here.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isNullToken, isNumber } from "./predicates";
import type { CellValue } from "./types";
import { typeInferenceLayer } from "./type-inference";

const NUM_RUNS = 200;

/** Currency prefixes accepted by {@link isNumber} (symbols + words). */
const CURRENCY_PREFIXES = ["$", "€", "£", "₹", "EUR", "GBP", "INR"];

/**
 * A finite number (no NaN / ±Infinity) whose magnitude stays in a range that
 * round-trips cleanly through decimal string forms. Includes `0`, negatives,
 * and fractional values.
 */
const finiteNumber = fc
  .double({
    min: -1_000_000_000,
    max: 1_000_000_000,
    noNaN: true,
    noDefaultInfinity: true,
  })
  .filter((n) => Number.isFinite(n));

/** Render a number as a plain decimal/scientific string the predicate accepts. */
function numberToCoreString(n: number): string {
  // `String(n)` yields plain decimals and (for very small/large values)
  // scientific notation like `1e-7`, both of which the predicate's strict
  // decimal pattern accepts. It never emits thousands commas or NaN/Infinity
  // for the finite inputs above.
  return String(n);
}

/**
 * Insert thousands-separator commas into the integer part of a plain decimal
 * string (no exponent). Commas are stripped by the predicate before
 * validation, so this must stay a value `isNumber` accepts.
 */
function withThousandsSeparators(core: string): string {
  if (/[eE]/.test(core)) {
    // Scientific notation: leave it alone (commas there would be invalid).
    return core;
  }
  const negative = core.startsWith("-") || core.startsWith("+");
  const sign = negative ? core[0] : "";
  const unsigned = negative ? core.slice(1) : core;
  const [intPart, fracPart] = unsigned.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + (fracPart === undefined ? grouped : `${grouped}.${fracPart}`);
}

/**
 * Generator for a single number-like string spanning every accepted form:
 * bare numbers, currency-prefixed, thousands separators, surrounding
 * whitespace, and a trailing percent sign. Every produced value is asserted
 * (via a post-filter) to satisfy `isNumber`, so the generator can never drift
 * out of sync with the predicate.
 */
const numberLikeString = fc
  .record({
    base: finiteNumber,
    useCommas: fc.boolean(),
    currency: fc.option(fc.constantFrom(...CURRENCY_PREFIXES), { nil: null }),
    percent: fc.boolean(),
    leadSpace: fc.constantFrom("", " ", "  ", "\t"),
    trailSpace: fc.constantFrom("", " ", "  ", "\t"),
  })
  .map(({ base, useCommas, currency, percent, leadSpace, trailSpace }) => {
    let core = numberToCoreString(base);
    if (useCommas) {
      core = withThousandsSeparators(core);
    }
    // A currency word (EUR/GBP/INR) directly followed by a leading '-' would be
    // ambiguous after the prefix is stripped; the predicate re-trims, so a
    // space keeps it clean. Symbols are fine adjacent to a sign.
    let body = core;
    if (currency !== null) {
      const sep = /^[A-Za-z]/.test(currency) ? " " : "";
      body = `${currency}${sep}${core}`;
    }
    if (percent) {
      body = `${body}%`;
    }
    return `${leadSpace}${body}${trailSpace}`;
  })
  // Safety net: only keep values the predicate actually accepts. This keeps the
  // generator honest without hand-proving every combination.
  .filter((s) => isNumber(s));

/**
 * A `NullToken` value matching {@link isNullToken}: `null`, empty /
 * whitespace-only strings, or the texts `N/A` / `NA` / `null` / `-` in varied
 * casing and with surrounding whitespace.
 */
const nullTokenValue: fc.Arbitrary<CellValue> = fc.oneof(
  fc.constant(null),
  fc.constantFrom("", " ", "   ", "\t", "  \t "),
  fc.constantFrom(
    "N/A",
    "n/a",
    "N/a",
    "NA",
    "na",
    "Na",
    "null",
    "NULL",
    "Null",
    "-",
    " - ",
    "  NA  "
  )
);

/**
 * A column of values: at least one number-like string, plus zero or more
 * NullTokens interleaved at random positions. Guaranteeing one real number
 * keeps the all-NullToken case (task 7.11) out of this property.
 */
const numberColumnWithNullTokens: fc.Arbitrary<CellValue[]> = fc
  .record({
    numbers: fc.array(numberLikeString, { minLength: 1, maxLength: 12 }),
    nulls: fc.array(nullTokenValue, { minLength: 0, maxLength: 8 }),
  })
  .chain(({ numbers, nulls }) => {
    const combined: CellValue[] = [...numbers, ...nulls];
    // Shuffle so NullTokens land at random positions among the numbers.
    return fc.shuffledSubarray(combined, {
      minLength: combined.length,
      maxLength: combined.length,
    });
  });

/** Build the single-column table and return the inferred type of `col`. */
function inferSingleColumnType(values: CellValue[]): string {
  const rows: CellValue[][] = values.map((v) => [v]);
  const schema = typeInferenceLayer.infer(["col"], rows);
  return schema[0].type;
}

describe("Property 13: All-numbers infer number (including NullToken-mixed columns)", () => {
  it("infers 'number' for a column of only number-like values", () => {
    fc.assert(
      fc.property(
        fc.array(numberLikeString, { minLength: 1, maxLength: 15 }),
        (numbers) => {
          expect(inferSingleColumnType(numbers)).toBe("number");
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("infers 'number' when NullTokens are interleaved with numbers (NullTokens excluded)", () => {
    fc.assert(
      fc.property(numberColumnWithNullTokens, (values) => {
        // Precondition for this property: at least one real number is present.
        const present = values.filter((v) => !isNullToken(v));
        expect(present.length).toBeGreaterThan(0);
        expect(present.every(isNumber)).toBe(true);

        expect(inferSingleColumnType(values)).toBe("number");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("handles representative messy number forms (currency, separators, whitespace, percent)", () => {
    // Deterministic spot-checks that each accepted surface form, mixed with
    // NullTokens, still infers `number`.
    const examples = [
      "42",
      "-3.14",
      "0",
      "1e3",
      "$1,234.56",
      "€9.99",
      "£10",
      "₹100",
      "EUR 9.99",
      "GBP 10",
      "INR 100",
      "1,000,000",
      "  42 ",
      "12%",
      "99.5%",
    ];
    // Every example must be accepted by the predicate (guards against drift).
    for (const ex of examples) {
      expect(isNumber(ex)).toBe(true);
    }
    const withNulls: CellValue[] = [
      examples[0],
      null,
      examples[4],
      "N/A",
      examples[11],
      "",
      examples[13],
      "-",
    ];
    expect(inferSingleColumnType(examples)).toBe("number");
    expect(inferSingleColumnType(withNulls)).toBe("number");
  });
});
