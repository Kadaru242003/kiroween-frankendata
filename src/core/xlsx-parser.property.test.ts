/**
 * Property-based tests for {@link XlsxParser} parsing fidelity.
 *
 * Feature: frankendata-file-intake, Property 2: XLSX parsing fidelity
 *
 * Validates: Requirements 4.1, 4.4, 10.2
 *
 * Property statement (design.md Property 2): For any valid XLSX input of any row
 * and column count, parsing produces the expected rows and columns, and the
 * parsed column names equal the first row of the first sheet.
 *
 * Strategy:
 *  - Generate a random table: a header row (column names) plus N (>= 1) data
 *    rows of M (>= 1) columns. Every cell and header token is a non-empty,
 *    non-whitespace STRING so that the XlsxParser's cell-value normalization is
 *    the identity (string → as-is). This isolates the parsing-fidelity concern
 *    from the number/boolean/date normalization paths, which are covered by the
 *    dedicated normalization and serial-date tasks (6.4/6.5).
 *  - Each token is forced to begin with a letter and contain at least one
 *    letter so SheetJS never reinterprets it as a number, boolean, or date on
 *    read (the parser reads with `raw: true`, but we keep inputs unambiguous).
 *  - Tokens never start or end with whitespace: the parser normalizes a
 *    whitespace-only cell to `null`, and leading/trailing spaces would be
 *    preserved verbatim, so we avoid both to keep fidelity assertions clean.
 *  - Build a genuinely valid XLSX workbook in-memory with SheetJS
 *    (`aoa_to_sheet` → `book_new`/`book_append_sheet` → `write({ type:"array",
 *    bookType:"xlsx" })`), wrap the resulting bytes in a File, parse it, and
 *    assert columnNames deep-equals the header, rows deep-equals the data rows,
 *    and the row count matches.
 */

import * as XLSX from "xlsx";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { XlsxParser } from "./xlsx-parser";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/**
 * A single cell/header token. We draw from a letter/digit charset plus a few
 * safe symbols and an interior space, then force the token to:
 *  - begin with an ASCII letter (so it is unambiguously a string, never a
 *    number/date/boolean when SheetJS reads it back), and
 *  - have no leading/trailing whitespace (a whitespace-only or blank cell is
 *    normalized to `null` by the parser; edge whitespace would survive but
 *    muddy the fidelity assertion).
 *
 * The leading-letter prefix also guarantees every token is non-empty, so
 * SheetJS never trims it away as a blank trailing cell.
 */
const tokenArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/@#%&*+=".split(
        ""
      ),
      // an interior space exercises spaces inside a cell
      " "
    ),
    minLength: 0,
    maxLength: 11,
  })
  // Trim edge whitespace so no cell normalizes to null and no trimming
  // ambiguity creeps into the fidelity check.
  .map((s) => s.trim())
  // Prefix with a fixed ASCII letter: keeps every token non-empty and forces
  // SheetJS to treat it as a string rather than a number/boolean/date.
  .map((s) => `x${s}`);

/**
 * A table: `columnNames` of width M (M >= 1) plus `rows` data rows (N >= 1),
 * every row exactly M columns wide. At least one data row keeps the workbook
 * non-empty (the parser treats zero data rows as an `empty-file` error).
 */
const tableArb = fc.integer({ min: 1, max: 6 }).chain((cols) =>
  fc.record({
    columnNames: fc.array(tokenArb, { minLength: cols, maxLength: cols }),
    rows: fc.array(fc.array(tokenArb, { minLength: cols, maxLength: cols }), {
      minLength: 1,
      maxLength: 8,
    }),
  })
);

/**
 * Build a valid XLSX File from a header row + data rows using SheetJS. The
 * array-of-arrays becomes a worksheet, which is appended to a fresh workbook
 * and written to an `xlsx` byte array — guaranteeing the input is a genuine,
 * well-formed XLSX file. jsdom (the Vitest environment) provides the File
 * constructor and File.arrayBuffer() used by XlsxParser.
 */
function xlsxFile(
  columnNames: string[],
  rows: string[][],
  name = "generated.xlsx"
): File {
  const aoa: string[][] = [columnNames, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
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

describe("XlsxParser — Property 2: XLSX parsing fidelity", () => {
  const parser = new XlsxParser();

  it("preserves column names, data rows, and row count for any valid XLSX", async () => {
    await fc.assert(
      fc.asyncProperty(tableArb, async ({ columnNames, rows }) => {
        const parsed = await parser.parse(xlsxFile(columnNames, rows));

        // Column names equal the first row of the first sheet (Req 4.4).
        expect(parsed.columnNames).toEqual(columnNames);
        // Data rows are preserved exactly, header excluded (Req 4.1).
        expect(parsed.rows).toEqual(rows);
        // Row count matches the generated data-row count (Req 10.2).
        expect(parsed.rows.length).toBe(rows.length);
        // sourceFileName is carried through from the File.
        expect(parsed.sourceFileName).toBe("generated.xlsx");
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
