/**
 * Property-based test for inference never throwing.
 *
 * Feature: frankendata-file-intake, Property 20: Inference never throws
 *
 * Validates: Requirements 5.10, 10.8
 *
 * Property 20 statement: For any arbitrary input — including malformed, very
 * long, or non-printable strings, `null` cells, empty arrays, ragged rows, and
 * mismatched column/row shapes — the {@link TypeInferenceLayer}'s `infer`
 * returns a `ColumnSchema[]` without throwing an exception. Every returned
 * entry carries a type drawn from the four allowed `ColumnType` values
 * (`number`, `boolean`, `date`, `string`).
 *
 * The function under test is {@link typeInferenceLayer}'s `infer` from
 * `type-inference.ts`. This is a totality/robustness property: the classifier
 * is a total function over its entire input space and degrades gracefully (to
 * `string` for affected columns) rather than raising. To stress that, the
 * generators below deliberately produce pathological inputs:
 *   - arbitrary strings including full-unicode and non-printable code points,
 *     and very long strings (large `maxLength`);
 *   - `null` cells and textual null tokens;
 *   - arbitrary, independently-chosen column counts and row counts;
 *   - ragged rows (inner arrays of differing lengths), empty rows, more or
 *     fewer cells than there are column names;
 *   - empty `columnNames` with non-empty `rows` and vice versa;
 *   - empty arrays as edge cases.
 *
 * Each `infer` call is wrapped in `expect(() => ...).not.toThrow()`, and the
 * returned value is additionally asserted to be an array whose entries each
 * carry a type in {"number", "boolean", "date", "string"}.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { typeInferenceLayer } from "./type-inference";
import type { CellValue, ColumnType } from "./types";

const NUM_RUNS = 200;

/** The four — and only four — allowed inferred types (Req 5.3). */
const ALLOWED_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  "number",
  "boolean",
  "date",
  "string",
]);

/**
 * A pathological cell-value arbitrary. Spans:
 *   - `null`;
 *   - full-unicode strings (may include non-printable / surrogate code points);
 *   - very long strings (up to 5000 chars) to stress length handling;
 *   - textual null tokens and type-looking tokens, so columns sometimes look
 *     uniform and sometimes mix.
 */
const pathologicalCell: fc.Arbitrary<CellValue> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<CellValue>(null) },
  // Full-unicode: `unit: "binary"` draws from the entire code-point range,
  // including control chars, lone surrogates, and non-printable points.
  { weight: 5, arbitrary: fc.string({ unit: "binary", maxLength: 50 }) },
  // Very long strings.
  { weight: 1, arbitrary: fc.string({ maxLength: 5000 }) },
  // Non-printable / control-ish constants plus assorted tokens.
  {
    weight: 2,
    arbitrary: fc.constantFrom<CellValue>(
      "",
      "   ",
      "\t\n\r",
      "\u0000",
      "\u0000\u0001\u0002",
      "\uffff",
      "N/A",
      "null",
      "-",
      "42",
      "-3.14",
      "1e3",
      "$1,234.5",
      "12%",
      "true",
      "no",
      "2023-05-01",
      "Jan 5, 2026"
    ),
  }
);

/** A single ragged/arbitrary-width row (may be empty). */
const pathologicalRow: fc.Arbitrary<CellValue[]> = fc.array(pathologicalCell, {
  minLength: 0,
  maxLength: 10,
});

/**
 * A fully arbitrary table: column names and rows are generated *independently*,
 * so counts are intentionally mismatched (empty names with rows, rows with more
 * or fewer cells than names, empty rows, etc.). Column names themselves are
 * arbitrary full-unicode strings.
 */
const arbitraryTable = fc.record({
  columnNames: fc.array(fc.string({ unit: "binary", maxLength: 30 }), {
    minLength: 0,
    maxLength: 8,
  }),
  rows: fc.array(pathologicalRow, { minLength: 0, maxLength: 15 }),
});

/** Assert `infer` does not throw and returns a well-formed schema array. */
function assertSafeInfer(columnNames: string[], rows: CellValue[][]): void {
  let schema: ReturnType<typeof typeInferenceLayer.infer> | undefined;

  expect(() => {
    schema = typeInferenceLayer.infer(columnNames, rows);
  }).not.toThrow();

  // Returned value is an array...
  expect(Array.isArray(schema)).toBe(true);
  // ...with exactly one entry per column name...
  expect(schema!.length).toBe(columnNames.length);
  // ...each carrying a type in the allowed set.
  for (const column of schema!) {
    expect(ALLOWED_TYPES.has(column.type)).toBe(true);
  }
}

describe("Property 20: Inference never throws", () => {
  it("never throws and returns a valid schema for arbitrary pathological tables", () => {
    fc.assert(
      fc.property(arbitraryTable, ({ columnNames, rows }) => {
        assertSafeInfer(columnNames, rows);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("handles empty-array and mismatched-shape edge cases without throwing", () => {
    // Both empty.
    assertSafeInfer([], []);
    // Column names, but no rows.
    assertSafeInfer(["a", "b", "c"], []);
    // Rows, but no column names (nothing to classify → empty schema).
    assertSafeInfer([], [["x", "y"], ["z"]]);
    // Ragged rows: differing lengths, more/fewer cells than column names.
    assertSafeInfer(
      ["a", "b"],
      [["1"], ["2", "3", "extra"], [], ["only-one"]]
    );
    // Empty rows interspersed.
    assertSafeInfer(["a"], [[], [], []]);
  });

  it("never throws for very long and non-printable string cells", () => {
    const veryLong = "x".repeat(100_000);
    const nonPrintable = "\u0000\u0001\u0002\u0003\uffff\u200b";
    assertSafeInfer(
      ["long", "weird"],
      [
        [veryLong, nonPrintable],
        [nonPrintable, veryLong],
        [null, ""],
      ]
    );
  });
});
