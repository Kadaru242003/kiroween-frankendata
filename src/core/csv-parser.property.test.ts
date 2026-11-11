/**
 * Property-based tests for {@link CsvParser} parsing fidelity.
 *
 * Feature: frankendata-file-intake, Property 1: CSV parsing fidelity
 *
 * Validates: Requirements 3.1, 3.4, 10.1
 *
 * Property statement (design.md Property 1): For any valid CSV input of any row
 * and column count, parsing produces the expected rows and columns, and the
 * parsed column names equal the first row of the CSV.
 *
 * Strategy:
 *  - Generate a random table: a header row (column names) plus N data rows of M
 *    columns. To keep the CSV round-trip unambiguous we draw every cell/header
 *    token from a charset that excludes the comma (field delimiter), the double
 *    quote (CSV quoting), and any newline/carriage-return (row delimiter). Every
 *    token is non-empty and not whitespace-only so that PapaParse's
 *    `skipEmptyLines: "greedy"` never drops a generated row — keeping the parsed
 *    row count equal to the generated data-row count.
 *  - Serialize the table to CSV text (join cells with ",", join rows with "\n").
 *  - Construct a File from the text and feed it through CsvParser.parse.
 *  - Assert columnNames deep-equals the header, rows deep-equals the data rows,
 *    and the row count matches.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvParser } from "./csv-parser";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/**
 * A single cell/header token. Characters are restricted to an unambiguous
 * subset for raw (unquoted) CSV:
 *  - no comma (`,`), which is the field delimiter;
 *  - no double quote (`"`), which triggers CSV field quoting;
 *  - no CR/LF, which are row delimiters.
 * We also forbid leading/trailing whitespace and whitespace-only tokens so that
 * `skipEmptyLines: "greedy"` cannot discard a row and so values round-trip
 * exactly (PapaParse preserves interior/edge whitespace verbatim, but an all-
 * whitespace row would be dropped).
 */
const tokenArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/@#$%&*+=".split(
        ""
      ),
      // include an interior space to exercise spaces inside fields
      " "
    ),
    minLength: 1,
    maxLength: 12,
  })
  // Reject whitespace-only / edge-whitespace tokens to avoid empty-row drops
  // and trimming ambiguity.
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * A table: `columnNames` of width M (M >= 1) plus `rows` data rows (N >= 1),
 * every row exactly M columns wide. At least one data row keeps the CSV valid
 * and non-empty (the parser treats zero data rows as an `empty-file` error).
 */
const tableArb = fc
  .integer({ min: 1, max: 6 }) // number of columns M
  .chain((cols) =>
    fc.record({
      columnNames: fc.array(tokenArb, { minLength: cols, maxLength: cols }),
      rows: fc.array(
        fc.array(tokenArb, { minLength: cols, maxLength: cols }),
        { minLength: 1, maxLength: 8 } // at least one data row N
      ),
    })
  );

/** Serialize a table to raw CSV text (no quoting needed given the charset). */
function toCsv(columnNames: string[], rows: string[][]): string {
  return [columnNames, ...rows].map((row) => row.join(",")).join("\n");
}

/**
 * Construct a File from CSV text. jsdom (the Vitest environment here) provides
 * the File/Blob constructors, and File.arrayBuffer() — which CsvParser uses via
 * TextDecoder — is available, so no polyfill is required.
 */
function csvFile(text: string, name = "generated.csv"): File {
  return new File([text], name, { type: "text/csv" });
}

describe("CsvParser — Property 1: CSV parsing fidelity", () => {
  const parser = new CsvParser();

  it("preserves column names, data rows, and row count for any valid CSV", async () => {
    await fc.assert(
      fc.asyncProperty(tableArb, async ({ columnNames, rows }) => {
        const csv = toCsv(columnNames, rows);
        const parsed = await parser.parse(csvFile(csv));

        // Column names equal the first row of the CSV (Req 3.4).
        expect(parsed.columnNames).toEqual(columnNames);
        // Data rows are preserved exactly, header excluded (Req 3.1).
        expect(parsed.rows).toEqual(rows);
        // Row count matches the generated data-row count (Req 10.1).
        expect(parsed.rows.length).toBe(rows.length);
        // sourceFileName is carried through from the File.
        expect(parsed.sourceFileName).toBe("generated.csv");
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
