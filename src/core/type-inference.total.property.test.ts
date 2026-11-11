/**
 * Property-based test for type inference total classification.
 *
 * Feature: frankendata-file-intake, Property 11: Type inference total classification
 *
 * Validates: Requirements 5.3
 *
 * Property 11 statement: For any column, the inferred `ColumnType` is exactly
 * one of `number`, `boolean`, `date`, or `string` — never zero, never more
 * than one. In other words, classification is a *total function* from columns
 * to the four-member `ColumnType` set.
 *
 * The layer under test is {@link createTypeInferenceLayer}'s `infer`, which is
 * pure over its inputs and never throws (Req 5.10). This test drives it with
 * arbitrary tabular data — arbitrary column/row counts and a mix of arbitrary
 * strings, nulls, null tokens, numeric strings, booleans, and dates — and
 * asserts that every returned schema entry carries a type drawn from exactly
 * the four allowed values, and that there is exactly one schema entry per
 * column name.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTypeInferenceLayer } from "./type-inference";
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
 * A cell-value arbitrary spanning the full input space the classifier must
 * tolerate: arbitrary free text, `null`, textual null tokens, numeric strings,
 * boolean literals, and date strings. The mix guarantees columns that are
 * uniform in a type as well as columns that mix types (which must fall through
 * to `string`).
 */
const cellValue: fc.Arbitrary<CellValue> = fc.oneof(
  // Arbitrary free text (may incidentally look like anything).
  fc.string({ maxLength: 20 }),
  // The JS null value — treated as a null token.
  fc.constant<CellValue>(null),
  // Textual null tokens (Req 5.2), with assorted casing/whitespace.
  fc.constantFrom<CellValue>("", "  ", "N/A", "na", "null", "-", " NULL "),
  // Numeric strings in the shapes isNumber accepts.
  fc.constantFrom<CellValue>("42", "-3.14", "1e3", "0", "1,234.5", "$10", "12%"),
  // Boolean literals (Req 5.6).
  fc.constantFrom<CellValue>("true", "FALSE", "Yes", "no"),
  // Date strings in the recognized formats (Req 5.7).
  fc.constantFrom<CellValue>("2023-05-01", "05/01/2023", "01-05-2023", "Jan 5, 2026")
);

/**
 * Generate an aligned table: pick a column count, generate exactly that many
 * column names, and generate a ragged-tolerant grid of rows whose inner arrays
 * are (mostly) the chosen width. `infer` must tolerate ragged rows, so the row
 * width is allowed to vary independently — this still exercises the one-type-
 * per-column invariant.
 */
const table = fc
  .integer({ min: 0, max: 8 })
  .chain((columnCount) =>
    fc.record({
      columnNames: fc.array(fc.string({ maxLength: 12 }), {
        minLength: columnCount,
        maxLength: columnCount,
      }),
      rows: fc.array(
        fc.array(cellValue, { minLength: 0, maxLength: columnCount + 2 }),
        { minLength: 0, maxLength: 12 }
      ),
    })
  );

describe("Property 11: Type inference total classification", () => {
  it("classifies every column as exactly one of the four allowed types, one per column", () => {
    const layer = createTypeInferenceLayer();

    fc.assert(
      fc.property(table, ({ columnNames, rows }) => {
        const schema = layer.infer(columnNames, rows);

        // Exactly one schema entry per column name (never zero, never more).
        expect(schema.length).toBe(columnNames.length);

        for (const column of schema) {
          // The inferred type is one of exactly the four allowed values.
          expect(ALLOWED_TYPES.has(column.type)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
