/**
 * Property-based test for all-NullToken column inference.
 *
 * Feature: frankendata-file-intake, Property 19: All-NullToken column infers string
 *
 * Validates: Requirements 5.9
 *
 * Property 19 statement: For any column containing only `NullToken`s, the
 * inferred `ColumnType` is `string`. Because `NullToken` values are excluded
 * before classification, a column with zero non-`NullToken` values has nothing
 * to classify and therefore falls through to `string` (Req 5.9).
 *
 * The function under test is {@link TypeInferenceLayer.infer} from
 * `type-inference.ts` (exercised via the `typeInferenceLayer` singleton). The
 * table is built as a single column: `columnNames = ["col"]` and
 * `rows = values.map((v) => [v])`. The assertion is
 * `infer(columnNames, rows)[0].type === "string"`.
 *
 * The `NullToken` generator below is kept deliberately consistent with
 * {@link isNullToken} in `predicates.ts`, covering every recognized form:
 *   - the JS value `null`;
 *   - empty and whitespace-only strings;
 *   - the texts `N/A`, `NA`, `null`, and a single hyphen `-`, in arbitrary
 *     casing and with arbitrary surrounding whitespace.
 * A `.filter(isNullToken)` safety net keeps the generator honest: only values
 * the predicate actually treats as null tokens reach the assertion, so the
 * generator can never drift out of sync with the predicate. Each generated
 * column also asserts that *every* value isNullToken before classification.
 *
 * The edge case of an empty column (zero rows) is also covered: a single
 * column with `rows = []` has zero non-`NullToken` values and must infer
 * `string` as well.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isNullToken } from "./predicates";
import type { CellValue } from "./types";
import { typeInferenceLayer } from "./type-inference";

const NUM_RUNS = 200;

/** Casings of the literal textual null tokens recognized by {@link isNullToken}. */
const NULL_TOKEN_TEXTS = [
  "N/A",
  "n/a",
  "N/a",
  "n/A",
  "NA",
  "na",
  "Na",
  "nA",
  "null",
  "NULL",
  "Null",
  "nUlL",
  "-",
];

/** Surrounding-whitespace fragments to pad textual null tokens and build blank cells. */
const WHITESPACE = ["", " ", "  ", "\t", " \t ", "\t\t"];

/**
 * A `NullToken` value matching {@link isNullToken}: the JS value `null`,
 * empty / whitespace-only strings, or the texts `N/A` / `NA` / `null` / `-`
 * in varied casing wrapped in arbitrary surrounding whitespace.
 *
 * The trailing `.filter(isNullToken)` guarantees every emitted value really is
 * a null token, so the generator cannot drift from the predicate.
 */
const nullTokenValue: fc.Arbitrary<CellValue> = fc
  .oneof(
    // The JS null value.
    fc.constant<CellValue>(null),
    // Whitespace-only (and empty) strings.
    fc.constantFrom<CellValue>(...WHITESPACE),
    // Textual null tokens with arbitrary surrounding whitespace.
    fc
      .record({
        lead: fc.constantFrom(...WHITESPACE),
        text: fc.constantFrom(...NULL_TOKEN_TEXTS),
        trail: fc.constantFrom(...WHITESPACE),
      })
      .map(({ lead, text, trail }) => `${lead}${text}${trail}` as CellValue)
  )
  // Safety net: only keep values the predicate treats as null tokens.
  .filter(isNullToken);

/** A column of one or more values where EVERY value is a NullToken. */
const allNullTokenColumn: fc.Arbitrary<CellValue[]> = fc.array(nullTokenValue, {
  minLength: 1,
  maxLength: 15,
});

/** Build the single-column table and return the inferred type of `col`. */
function inferSingleColumnType(values: CellValue[]): string {
  const rows: CellValue[][] = values.map((v) => [v]);
  const schema = typeInferenceLayer.infer(["col"], rows);
  return schema[0].type;
}

describe("Property 19: All-NullToken column infers string", () => {
  it("infers 'string' for a column whose every value is a NullToken", () => {
    fc.assert(
      fc.property(allNullTokenColumn, (values) => {
        // Precondition for this property: every value is a null token.
        expect(values.length).toBeGreaterThan(0);
        expect(values.every(isNullToken)).toBe(true);

        expect(inferSingleColumnType(values)).toBe("string");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("infers 'string' for an empty column (zero rows)", () => {
    // Edge case: a single column with no rows has zero non-NullToken values and
    // must still classify as string (Req 5.9).
    const schema = typeInferenceLayer.infer(["col"], []);
    expect(schema).toHaveLength(1);
    expect(schema[0].type).toBe("string");
  });

  it("infers 'string' for representative null-token forms", () => {
    // Deterministic spot-checks across every recognized surface form.
    const examples: CellValue[] = [
      null,
      "",
      "   ",
      "\t",
      "N/A",
      "n/a",
      " NA ",
      "null",
      " NULL ",
      "-",
      " - ",
    ];
    // Every example must be a null token (guards against drift).
    for (const ex of examples) {
      expect(isNullToken(ex)).toBe(true);
    }
    expect(inferSingleColumnType(examples)).toBe("string");
  });
});
