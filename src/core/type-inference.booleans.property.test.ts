/**
 * Property-based tests for all-booleans column inference.
 *
 * Feature: frankendata-file-intake, Property 16: All-booleans infer boolean
 *
 * Validates: Requirements 5.6, 10.4
 *
 * Property 16 statement: For any column whose non-`NullToken` values are all
 * one of `true`, `false`, `yes`, or `no` (case-insensitive, with optional
 * surrounding whitespace), the inferred `ColumnType` is `boolean`. This holds
 * for columns that mix `NullToken`s with booleans, because `NullToken` values
 * are excluded before classification.
 *
 * The function under test is {@link TypeInferenceLayer.infer} from
 * `type-inference.ts` (exercised via the `typeInferenceLayer` singleton). The
 * table is built as a single column: `columnNames = ["col"]` and
 * `rows = values.map((v) => [v])`. The assertion is
 * `infer(columnNames, rows)[0].type === "boolean"`.
 *
 * The boolean-literal generator is kept deliberately consistent with
 * `isBoolean` in `predicates.ts` (`/^(?:true|false|yes|no)$/i` after trim), so
 * every generated value is actually accepted as a boolean:
 *   - the literals `true` / `false` / `yes` / `no` in arbitrary casing;
 *   - surrounding whitespace is trimmed by the predicate, so leading/trailing
 *     spaces/tabs are allowed.
 * Crucially, bare `0` / `1` are NOT booleans (they are numbers), so they are
 * never generated — this keeps the generator in sync with the predicate and
 * the mutual-exclusivity design invariant.
 *
 * NullTokens are generated to match `isNullToken`: empty / whitespace-only
 * strings, the JS value `null`, and the texts `N/A` / `NA` / `null` / `-`
 * (case-insensitive after trimming). At least one real boolean is always
 * present so the all-`NullToken` case (Property 19 / task 7.11) never sneaks
 * in here.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isBoolean, isNullToken } from "./predicates";
import type { CellValue } from "./types";
import { typeInferenceLayer } from "./type-inference";

const NUM_RUNS = 200;

/** The four boolean literals accepted by {@link isBoolean}. */
const BOOLEAN_LITERALS = ["true", "false", "yes", "no"];

/**
 * Re-case a literal into arbitrary mixed casing (e.g. `TrUe`, `YES`, `no`).
 * Each character is independently upper- or lower-cased.
 */
function mixedCasing(literal: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: literal.length, maxLength: literal.length })
    .map((upperFlags) =>
      literal
        .split("")
        .map((ch, i) => (upperFlags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join("")
    );
}

/**
 * Generator for a single boolean-literal string across every accepted form:
 * one of the four literals, arbitrary casing, and optional surrounding
 * whitespace. Every produced value is asserted (via a post-filter) to satisfy
 * `isBoolean`, so the generator can never drift out of sync with the predicate.
 */
const booleanLikeString = fc
  .record({
    literal: fc.constantFrom(...BOOLEAN_LITERALS),
    leadSpace: fc.constantFrom("", " ", "  ", "\t"),
    trailSpace: fc.constantFrom("", " ", "  ", "\t"),
  })
  .chain(({ literal, leadSpace, trailSpace }) =>
    mixedCasing(literal).map((cased) => `${leadSpace}${cased}${trailSpace}`)
  )
  // Safety net: only keep values the predicate actually accepts. Guards against
  // the generator drifting away from `isBoolean`.
  .filter((s) => isBoolean(s));

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
 * A column of values: at least one boolean-literal string, plus zero or more
 * NullTokens interleaved at random positions. Guaranteeing one real boolean
 * keeps the all-NullToken case (task 7.11) out of this property.
 */
const booleanColumnWithNullTokens: fc.Arbitrary<CellValue[]> = fc
  .record({
    booleans: fc.array(booleanLikeString, { minLength: 1, maxLength: 12 }),
    nulls: fc.array(nullTokenValue, { minLength: 0, maxLength: 8 }),
  })
  .chain(({ booleans, nulls }) => {
    const combined: CellValue[] = [...booleans, ...nulls];
    // Shuffle so NullTokens land at random positions among the booleans.
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

describe("Property 16: All-booleans infer boolean", () => {
  it("infers 'boolean' for a column of only boolean-literal values", () => {
    fc.assert(
      fc.property(
        fc.array(booleanLikeString, { minLength: 1, maxLength: 15 }),
        (booleans) => {
          expect(inferSingleColumnType(booleans)).toBe("boolean");
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("infers 'boolean' when NullTokens are interleaved with booleans (NullTokens excluded)", () => {
    fc.assert(
      fc.property(booleanColumnWithNullTokens, (values) => {
        // Precondition for this property: at least one real boolean is present.
        const present = values.filter((v) => !isNullToken(v));
        expect(present.length).toBeGreaterThan(0);
        expect(present.every(isBoolean)).toBe(true);

        expect(inferSingleColumnType(values)).toBe("boolean");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("handles representative boolean forms (casing, whitespace, NullToken-mixed)", () => {
    // Deterministic spot-checks that each accepted surface form, mixed with
    // NullTokens, still infers `boolean`.
    const examples = [
      "true",
      "TRUE",
      "True",
      "false",
      "FALSE",
      "FaLsE",
      "yes",
      "YES",
      "Yes",
      "no",
      "NO",
      "No",
      "  true ",
      "\tyes\t",
    ];
    // Every example must be accepted by the predicate (guards against drift).
    for (const ex of examples) {
      expect(isBoolean(ex)).toBe(true);
    }
    const withNulls: CellValue[] = [
      examples[0],
      null,
      examples[3],
      "N/A",
      examples[6],
      "",
      examples[9],
      "-",
    ];
    expect(inferSingleColumnType(examples)).toBe("boolean");
    expect(inferSingleColumnType(withNulls)).toBe("boolean");
  });
});
