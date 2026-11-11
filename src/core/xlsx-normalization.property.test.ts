/**
 * Property-based tests for {@link XlsxParser} cell-value string normalization.
 *
 * Feature: frankendata-file-intake, Property 30: XLSX cell value string normalization
 *
 * Validates: Requirements 4.1, 4.5
 *
 * Property statement (design.md Property 30): For any XLSX cell value returned
 * by SheetJS as a number, boolean, `Date` object, or string, the XlsxParser
 * normalizes it to a consistent string representation before it enters the type
 * inference pipeline (numbers → string form, booleans → `"true"`/`"false"`,
 * `Date` objects and Excel serial dates → ISO `YYYY-MM-DD` string, strings →
 * as-is; missing/empty cells → null), so the TypeInferenceLayer always receives
 * `string | null` inputs regardless of the source cell format.
 *
 * Strategy:
 *  - Generate a mix of cell-value "kinds" (number, boolean, Date, string) via
 *    fast-check. Each generated kind carries both the native value to place in
 *    the worksheet (so SheetJS stores its real cell type) and the expected
 *    normalized string the parser should produce.
 *  - Build a genuinely valid XLSX workbook in-memory with SheetJS: a header row
 *    (so the first row becomes column names) plus data rows holding the varied
 *    native values. The worksheet is created with `aoa_to_sheet({ cellDates:
 *    true })` so Date objects are stored as real date cells, then written to an
 *    `xlsx` byte array and wrapped in a File.
 *  - Parse with XlsxParser and assert each data cell equals its expected
 *    normalized string, AND that every returned cell is `string | null` — the
 *    core invariant that inference always receives strings.
 *
 * Number-string convention constraint:
 *  The parser normalizes a numeric cell with `String(n)`. To keep the expected
 *  string in exact agreement with what SheetJS round-trips, generated numbers
 *  are restricted to values whose decimal form round-trips exactly through both
 *  the XLSX storage and `String()`: integers and short, exactly-representable
 *  decimals (e.g. 42, -3.14). This avoids float-formatting divergence (e.g.
 *  values that would print differently after a storage round-trip). The expected
 *  value is always computed as `String(generatedNumber)`, matching the parser.
 */

import * as XLSX from "xlsx";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { XlsxParser } from "./xlsx-parser";
import type { CellValue } from "./types";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/** A native value to place in a worksheet cell (as SheetJS would surface it). */
type NativeCell = string | number | boolean | Date;

/** A generated cell: the native value to store + the expected normalized string. */
interface GeneratedCell {
  native: NativeCell;
  expected: CellValue;
}

/**
 * Format a Date's UTC calendar fields as ISO `YYYY-MM-DD`. Mirrors the parser's
 * `dateToIso`, which uses UTC getters to avoid timezone day-shift.
 */
function isoFromUtc(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Number cells: integers and simple two-decimal values. We generate the decimal
 * from an integer count of hundredths so the value is exactly representable and
 * `String()` prints a clean short form (e.g. -3.14, 42, 0). The expected
 * normalized string is `String(n)`, exactly matching the parser's convention.
 */
const numberCellArb: fc.Arbitrary<GeneratedCell> = fc
  .oneof(
    // Integers.
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    // Simple decimals: hundredths, exactly representable, short String() form.
    fc
      .integer({ min: -100_000, max: 100_000 })
      .map((hundredths) => hundredths / 100)
  )
  .map((n) => ({ native: n, expected: String(n) }));

/** Boolean cells → "true" / "false". */
const booleanCellArb: fc.Arbitrary<GeneratedCell> = fc
  .boolean()
  .map((b) => ({ native: b, expected: b ? "true" : "false" }));

/**
 * Date cells → ISO `YYYY-MM-DD`. Build the Date from UTC parts in a restricted
 * year range (1950..2100) so there is no timezone day-shift and no Excel-epoch
 * edge weirdness. Day is kept at 1..28 so every (year, month) pair is valid.
 */
const dateCellArb: fc.Arbitrary<GeneratedCell> = fc
  .record({
    year: fc.integer({ min: 1950, max: 2100 }),
    month: fc.integer({ min: 0, max: 11 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(({ year, month, day }) => {
    const native = new Date(Date.UTC(year, month, day));
    return { native, expected: isoFromUtc(native) };
  });

/**
 * String cells → identical string. Tokens are non-empty and forced to begin
 * with an ASCII letter: this keeps them unambiguously strings (never
 * reinterpreted as numbers/booleans/dates on read) and non-null (the parser
 * normalizes empty/whitespace-only strings to null). No leading/trailing
 * whitespace so the identity assertion is clean.
 */
const stringCellArb: fc.Arbitrary<GeneratedCell> = fc
  .string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/@#%&*+= ".split(
        ""
      )
    ),
    minLength: 0,
    maxLength: 11,
  })
  .map((s) => s.trim())
  .map((s) => `x${s}`)
  .map((s) => ({ native: s, expected: s }));

/** Any single cell kind. */
const cellArb: fc.Arbitrary<GeneratedCell> = fc.oneof(
  numberCellArb,
  booleanCellArb,
  dateCellArb,
  stringCellArb
);

/**
 * A table: a fixed-width set of columns (cols >= 1) with a header row plus
 * N (>= 1) data rows, each row an independently generated mix of cell kinds.
 */
const tableArb = fc.integer({ min: 1, max: 5 }).chain((cols) =>
  fc.record({
    columnNames: fc.array(
      fc.integer({ min: 1, max: 9999 }).map((i) => `col_${i}`),
      { minLength: cols, maxLength: cols }
    ),
    rows: fc.array(
      fc.array(cellArb, { minLength: cols, maxLength: cols }),
      { minLength: 1, maxLength: 8 }
    ),
  })
);

/**
 * Build a valid XLSX File from a header row + data rows of native values.
 * `aoa_to_sheet({ cellDates: true })` stores Date objects as real date cells so
 * the parser (which reads with `cellDates: true`) surfaces them as Dates again.
 */
function xlsxFile(
  columnNames: string[],
  rows: NativeCell[][],
  name = "normalization.xlsx"
): File {
  const aoa: NativeCell[][] = [columnNames, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const bytes = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;
  return new File([new Uint8Array(bytes)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("XlsxParser — Property 30: XLSX cell value string normalization", () => {
  const parser = new XlsxParser();

  it("normalizes every cell to its expected string form and never a non-string type", async () => {
    await fc.assert(
      fc.asyncProperty(tableArb, async ({ columnNames, rows }) => {
        const natives = rows.map((row) => row.map((c) => c.native));
        const expected = rows.map((row) => row.map((c) => c.expected));

        const parsed = await parser.parse(xlsxFile(columnNames, natives));

        // Shape is preserved: one normalized row per data row.
        expect(parsed.rows.length).toBe(rows.length);

        for (let r = 0; r < parsed.rows.length; r++) {
          const parsedRow = parsed.rows[r];
          const expectedRow = expected[r];
          expect(parsedRow.length).toBe(expectedRow.length);

          for (let c = 0; c < parsedRow.length; c++) {
            const value = parsedRow[c];

            // Core invariant: inference always receives string | null.
            expect(value === null || typeof value === "string").toBe(true);

            // Exact normalized value per cell kind.
            expect(value).toBe(expectedRow[c]);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
