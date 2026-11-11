/**
 * Property-based test for CSV export round-tripping.
 *
 * Feature: frankendata-chat-sql, Property 3: CSV export round-trips for
 * generated rows.
 *
 * Validates: Requirements 7.5, 7.6, 10.5
 *
 * Property 3 statement: for arbitrary generated rows of display values —
 * strings with commas, quotes, and newlines, plus numbers, booleans, and
 * empty strings — parsing `toCsv(columns, rows)` back with an INDEPENDENT
 * reference CSV parser (PapaParse, the same library Feature 1 uses) yields the
 * original values (compared as their string forms, since a parser returns text
 * fields).
 *
 * Pure-logic property: no DuckDB, no network.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import Papa from "papaparse";
import { toCsv } from "./csv-export";
import type { DisplayValue } from "./types";

/** A single display-value cell: tricky strings, numbers, booleans. */
function cellArb(): fc.Arbitrary<DisplayValue> {
  const trickyString = fc.string({ unit: "binary", maxLength: 24 });
  const number = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.float({ noNaN: true, noDefaultInfinity: true })
  );
  return fc.oneof(trickyString, number, fc.boolean());
}

/** What a CSV parser will read a cell back as: its string form. */
function expectedText(cell: DisplayValue): string {
  return typeof cell === "string" ? cell : String(cell);
}

/** Generate a column count and a matrix of rows aligned to it. */
function tableArb(): fc.Arbitrary<{ columns: string[]; rows: DisplayValue[][] }> {
  return fc.integer({ min: 1, max: 4 }).chain((ncols) =>
    fc
      .array(
        fc.array(cellArb(), { minLength: ncols, maxLength: ncols }),
        { maxLength: 20 }
      )
      .map((rows) => ({
        columns: Array.from({ length: ncols }, (_, i) => `c${i}`),
        rows,
      }))
  );
}

describe("Property 3 — CSV export round-trips (Req 7.5, 7.6, 10.5)", () => {
  it("parsing toCsv output reproduces every cell's string form", () => {
    fc.assert(
      fc.property(tableArb(), ({ columns, rows }) => {
        const csv = toCsv(columns, rows);
        const parsed = Papa.parse<string[]>(csv, {
          header: false,
          skipEmptyLines: false,
        });
        const data = parsed.data;
        // data[0] is the header; data[1..] are the rows.
        expect(data[0]).toEqual(columns);
        for (let r = 0; r < rows.length; r++) {
          expect(data[r + 1]).toEqual(rows[r].map(expectedText));
        }
      })
    );
  });
});
