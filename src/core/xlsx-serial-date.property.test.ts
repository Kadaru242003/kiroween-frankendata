/**
 * Property-based tests for {@link XlsxParser} Excel serial-date conversion.
 *
 * Feature: frankendata-file-intake, Property 5: Excel serial date conversion
 *
 * Validates: Requirements 4.5
 *
 * Property statement (design.md Property 5): For any Excel serial date number,
 * conversion to a calendar date yields the correct calendar date
 * (round-trippable against the Excel epoch), and the result is normalized to a
 * string in ISO `YYYY-MM-DD` form before entering type inference.
 *
 * Strategy (build a real XLSX with date cells so the serial-date path runs):
 *  - Generate an arbitrary valid calendar date. We draw year/month/day
 *    components and keep the date within 1950-01-01..2100-12-31. Staying at or
 *    after 1900-03-01 sidesteps the Excel 1900 leap-year bug (the phantom
 *    serial 60 = "1900-02-29"), so every generated date round-trips cleanly
 *    against the Excel epoch. Invalid day/month combinations (e.g. Feb 30) are
 *    discarded via a `filter` that re-derives the calendar date and checks it
 *    did not roll over.
 *  - Build a worksheet with a header row and a single date-typed cell using
 *    SheetJS `aoa_to_sheet(..., { cellDates: true })`, then write the workbook
 *    to an in-memory array buffer. With `cellDates: true` SheetJS writes the
 *    value as an Excel serial date number formatted as a date, so the parser's
 *    `cellDates: true` read path exercises the serial → calendar conversion.
 *  - Wrap the bytes in a File, parse with XlsxParser, and assert the single
 *    data cell equals the expected ISO `YYYY-MM-DD` string.
 *
 * Timezone handling: the parser's `dateToIso` reads UTC getters, and SheetJS's
 * date <-> serial conversion is calendar-field based. To make the round trip
 * timezone-independent we construct the JS Date at **UTC noon** of the target
 * calendar day. UTC noon is far enough from either midnight boundary that no
 * local-timezone offset applied anywhere in the SheetJS write/read path can
 * push the date across a day boundary, so the parsed ISO string always names
 * the generated calendar day. The expected ISO string is computed from the
 * same UTC components the parser uses, keeping the assertion self-consistent.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { XlsxParser } from "./xlsx-parser";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/** Zero-pad a positive integer to the given width. */
function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

/**
 * A valid calendar date in the range 1950-01-01..2100-12-31, represented by its
 * year/month/day components. Impossible day-of-month values (e.g. Feb 30, Apr
 * 31) are rejected by constructing the date at UTC noon and confirming the
 * calendar fields survived the round trip without rolling into the next month.
 */
const calendarDateArb = fc
  .record({
    year: fc.integer({ min: 1950, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }), // 1-based month
    day: fc.integer({ min: 1, max: 31 }),
  })
  .filter(({ year, month, day }) => {
    // UTC noon keeps us clear of midnight boundaries in both directions.
    const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
    return (
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month - 1 &&
      d.getUTCDate() === day
    );
  });

/**
 * Build an XLSX workbook (as a Uint8Array) containing a single date-typed cell.
 * `aoa_to_sheet(..., { cellDates: true })` plus `bookType: "xlsx"` writes the
 * date as an Excel serial number carrying a date number format, so reading it
 * back drives the serial-date conversion path under test.
 */
function xlsxBytesWithDate(date: Date): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet([["d"], [date]], { cellDates: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

/** Wrap XLSX bytes in a File the parser can read via `arrayBuffer()`. */
function xlsxFile(bytes: Uint8Array, name = "dates.xlsx"): File {
  return new File([bytes as BlobPart], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("XlsxParser — Property 5: Excel serial date conversion", () => {
  const parser = new XlsxParser();

  it("converts a date-formatted (serial) cell to the correct ISO YYYY-MM-DD string", async () => {
    await fc.assert(
      fc.asyncProperty(calendarDateArb, async ({ year, month, day }) => {
        // Target calendar day at UTC noon (boundary-safe for the round trip).
        const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
        const expectedIso = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;

        const bytes = xlsxBytesWithDate(date);
        const parsed = await parser.parse(xlsxFile(bytes));

        // One header ("d") + one data row with one cell.
        expect(parsed.columnNames).toEqual(["d"]);
        expect(parsed.rows.length).toBe(1);
        expect(parsed.rows[0]?.length).toBe(1);

        // The serial date is normalized to an ISO YYYY-MM-DD string (Req 4.5).
        expect(parsed.rows[0]?.[0]).toBe(expectedIso);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
