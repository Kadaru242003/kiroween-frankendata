/**
 * Property-based tests for mixed-or-unparseable column inference.
 *
 * Feature: frankendata-file-intake, Property 18: Mixed or unparseable infer string
 *
 * Validates: Requirements 5.8, 10.6
 *
 * Property 18 statement: For any column whose non-`NullToken` values are of
 * mixed or unparseable types, the inferred `ColumnType` is `string`.
 *
 * The function under test is {@link TypeInferenceLayer.infer} from
 * `type-inference.ts` (exercised via the `typeInferenceLayer` singleton). The
 * table is built as a single column: `columnNames = ["col"]` and
 * `rows = values.map((v) => [v])`. The assertion is
 * `infer(columnNames, rows)[0].type === "string"`.
 *
 * Column classification (design.md, "Column classification") excludes
 * `NullToken` values, then returns the first of `number`/`boolean`/`date`
 * whose predicate is satisfied by EVERY remaining value, else `string`. So a
 * column falls through to `string` in exactly two ways, both covered here:
 *
 *   1. MIXED: the non-`NullToken` values are not uniform under any single
 *      predicate — e.g. one `isNumber` value and one `isBoolean` value. No
 *      single predicate covers them all, so the column is `string`.
 *
 *   2. UNPARSEABLE: every non-`NullToken` value is free text that satisfies
 *      none of `isNumber`/`isBoolean`/`isDate` (and is not a `NullToken`), so
 *      no predicate is ever satisfied and the column is `string`.
 *
 * `NullToken`s are excluded before classification, so a column that mixes
 * `NullToken`s with a uniform real type is classified by that real type, NOT
 * as `string`. To keep this property honest:
 *   - the MIXED generator always includes >= 2 real values of DIFFERENT
 *     recognized types, so the surviving set can never be uniform; and
 *   - the UNPARSEABLE generator always includes >= 1 real unparseable value
 *     and `.filter`s out any generated value that happens to be a
 *     number/boolean/date/NullToken, so no uniform-type sneak-through is
 *     possible.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isBoolean, isDate, isNullToken, isNumber } from "./predicates";
import type { CellValue } from "./types";
import { typeInferenceLayer } from "./type-inference";

const NUM_RUNS = 200;

/** A value that satisfies {@link isNumber} (and only that predicate). */
const numberValue: fc.Arbitrary<string> = fc
  .constantFrom(
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
    "1,000,000",
    "12%",
    "99.5%"
  )
  .filter(isNumber);

/** A value that satisfies {@link isBoolean} (and only that predicate). */
const booleanValue: fc.Arbitrary<string> = fc
  .constantFrom("true", "false", "TRUE", "False", "yes", "no", "Yes", "NO")
  .filter(isBoolean);

/** A value that satisfies {@link isDate} (and only that predicate). */
const dateValue: fc.Arbitrary<string> = fc
  .constantFrom(
    "2023-05-01",
    "2026-12-31",
    "05/01/2023",
    "12/25/2024",
    "01-05-2023",
    "31-12-2026",
    "Jan 5, 2026",
    "March 3, 2020"
  )
  .filter(isDate);

/** A `NullToken` value matching {@link isNullToken}. */
const nullTokenValue: fc.Arbitrary<CellValue> = fc.oneof(
  fc.constant<CellValue>(null),
  fc.constantFrom<CellValue>("", "  ", "\t", "N/A", "n/a", "NA", "null", "NULL", "-", " - ")
);

/**
 * Free text that is genuinely unparseable: not a number, boolean, date, or
 * NullToken. We generate arbitrary strings and `.filter` out any that happen
 * to satisfy one of the predicates, so the column is guaranteed unparseable.
 */
const unparseableValue: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 20 }),
    // Words are a common real-world unparseable case; nudge the generator
    // toward them so runs aren't dominated by rejected symbol soup.
    fc.constantFrom(
      "hello",
      "world",
      "frankenstein",
      "lab result",
      "pending review",
      "see notes",
      "foo bar",
      "n/a-ish",
      "approximately 5",
      "2023ish",
      "true-ish",
      "unknown"
    )
  )
  .filter(
    (s) => !isNullToken(s) && !isNumber(s) && !isBoolean(s) && !isDate(s)
  );

/** Build the single-column table and return the inferred type of `col`. */
function inferSingleColumnType(values: CellValue[]): string {
  const rows: CellValue[][] = values.map((v) => [v]);
  const schema = typeInferenceLayer.infer(["col"], rows);
  return schema[0].type;
}

/**
 * MIXED strategy: a column with >= 2 real values of DIFFERENT recognized
 * types, so no single predicate can cover them all. We pick two distinct typed
 * generators, draw one value from each (guaranteeing non-uniformity), then
 * sprinkle in extra typed values and NullTokens and shuffle.
 */
const typedGenerators: fc.Arbitrary<string>[] = [numberValue, booleanValue, dateValue];

const mixedColumn: fc.Arbitrary<CellValue[]> = fc
  .record({
    // Two DISTINCT type indices so the two seed values are of different types.
    typeIndices: fc.uniqueArray(fc.integer({ min: 0, max: 2 }), {
      minLength: 2,
      maxLength: 2,
    }),
    seedA: fc.integer({ min: 0, max: 1000 }),
    seedB: fc.integer({ min: 0, max: 1000 }),
    extras: fc.array(fc.oneof(numberValue, booleanValue, dateValue), {
      minLength: 0,
      maxLength: 6,
    }),
    nulls: fc.array(nullTokenValue, { minLength: 0, maxLength: 5 }),
  })
  .chain(({ typeIndices, extras, nulls }) =>
    fc
      .record({
        a: typedGenerators[typeIndices[0]],
        b: typedGenerators[typeIndices[1]],
      })
      .chain(({ a, b }) => {
        const combined: CellValue[] = [a, b, ...extras, ...nulls];
        return fc.shuffledSubarray(combined, {
          minLength: combined.length,
          maxLength: combined.length,
        });
      })
  );

/**
 * UNPARSEABLE strategy: at least one real unparseable value, plus optional
 * extra unparseable values and NullTokens, shuffled. The surviving
 * (non-NullToken) set is entirely unparseable text.
 */
const unparseableColumn: fc.Arbitrary<CellValue[]> = fc
  .record({
    texts: fc.array(unparseableValue, { minLength: 1, maxLength: 10 }),
    nulls: fc.array(nullTokenValue, { minLength: 0, maxLength: 5 }),
  })
  .chain(({ texts, nulls }) => {
    const combined: CellValue[] = [...texts, ...nulls];
    return fc.shuffledSubarray(combined, {
      minLength: combined.length,
      maxLength: combined.length,
    });
  });

describe("Property 18: Mixed or unparseable infer string", () => {
  it("infers 'string' for a column mixing >= 2 different recognized types", () => {
    fc.assert(
      fc.property(mixedColumn, (values) => {
        // Preconditions: the surviving set is non-empty and genuinely
        // non-uniform — no single predicate covers all present values.
        const present = values.filter((v) => !isNullToken(v));
        expect(present.length).toBeGreaterThanOrEqual(2);
        expect(present.every(isNumber)).toBe(false);
        expect(present.every(isBoolean)).toBe(false);
        expect(present.every(isDate)).toBe(false);

        expect(inferSingleColumnType(values)).toBe("string");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("infers 'string' for a column of unparseable free text (NullTokens excluded)", () => {
    fc.assert(
      fc.property(unparseableColumn, (values) => {
        // Precondition: at least one real value, and every present value is
        // unparseable under all three predicates.
        const present = values.filter((v) => !isNullToken(v));
        expect(present.length).toBeGreaterThan(0);
        for (const v of present) {
          expect(isNumber(v)).toBe(false);
          expect(isBoolean(v)).toBe(false);
          expect(isDate(v)).toBe(false);
        }

        expect(inferSingleColumnType(values)).toBe("string");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("handles representative mixed and unparseable columns", () => {
    // Deterministic spot-checks.
    // Mixed: number + boolean + date, with NullTokens interleaved.
    expect(inferSingleColumnType(["42", "true", "2023-05-01"])).toBe("string");
    expect(inferSingleColumnType(["$1,234.56", "no", null, "N/A"])).toBe(
      "string"
    );
    expect(inferSingleColumnType(["12%", "Jan 5, 2026", "-"])).toBe("string");
    // Unparseable free text, with NullTokens interleaved.
    expect(inferSingleColumnType(["hello", "world", "foo bar"])).toBe("string");
    expect(inferSingleColumnType(["pending review", null, "see notes"])).toBe(
      "string"
    );
  });
});
