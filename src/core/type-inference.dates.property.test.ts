/**
 * Property-based tests for all-dates column inference.
 *
 * Feature: frankendata-file-intake, Property 17: All-dates infer date
 *
 * Validates: Requirements 5.7, 10.5
 *
 * Property 17 statement: For any column whose non-`NullToken` values all parse
 * as dates in ISO 8601 (`YYYY-MM-DD`), `MM/DD/YYYY` (month-first; slashes read
 * as month/day, never day/month), `DD-MM-YYYY` (day-first, dash-separated), or
 * a month-name format (e.g. `Jan 5, 2026`), the inferred `ColumnType` is
 * `date`.
 *
 * The function under test is {@link TypeInferenceLayer.infer} from
 * `type-inference.ts` (exercised via the `typeInferenceLayer` singleton). The
 * table is built as a single column: `columnNames = ["col"]` and
 * `rows = values.map((v) => [v])`. The assertion is
 * `infer(columnNames, rows)[0].type === "date"`.
 *
 * ## Matching `isDate`'s grammar exactly (predicates.ts)
 *
 * The date renderer below is kept deliberately consistent with `parseDateParts`
 * in `predicates.ts`, in particular the SEPARATOR that disambiguates the two
 * numeric-with-single-digit grammars:
 *   - ISO `YYYY-MM-DD`: 4-digit year first, 2-digit zero-padded month and day,
 *     dash-separated.
 *   - `MM/DD/YYYY`: month-FIRST, SLASH-separated (1-2 digit month/day, 4-digit
 *     year last). Slashes are always read month/day, never day/month.
 *   - `DD-MM-YYYY`: day-FIRST, DASH-separated (1-2 digit day/month, 4-digit
 *     year last). The 4-digit year being LAST is what distinguishes this from
 *     ISO, where the 4-digit year is FIRST.
 *   - Month-name: `"Jan 5, 2026"` / `"January 5 2026"` / `"5 Jan 2026"`.
 * Because the separator (dash vs slash) is what picks month-first vs day-first
 * in this grammar, every rendered string uses the correct separator for its
 * intended format.
 *
 * Only valid calendar dates are generated (real month lengths + leap years),
 * and years are kept in 1900..2100. A bare 4-digit year like `2023` is a
 * NUMBER, not a date, so we never emit bare years. Every produced value is
 * asserted (via a post-filter) to satisfy `isDate`, so the generator can never
 * drift out of sync with the predicate.
 *
 * NullTokens are generated to match `isNullToken`: empty / whitespace-only
 * strings, the JS value `null`, and the texts `N/A` / `NA` / `null` / `-`
 * (case-insensitive after trimming). At least one real date is always present
 * so the all-`NullToken` case (task 7.11) never sneaks in here.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isDate, isNullToken } from "./predicates";
import type { CellValue } from "./types";
import { typeInferenceLayer } from "./type-inference";

const NUM_RUNS = 200;

/** The accepted rendering formats, matching `parseDateParts` in predicates.ts. */
type DateFormat = "iso" | "slash" | "dash" | "month-name";

/** Month abbreviations/names the predicate recognizes (1-based index → forms). */
const MONTH_FORMS: string[][] = [
  ["Jan", "January"],
  ["Feb", "February"],
  ["Mar", "March"],
  ["Apr", "April"],
  ["May"],
  ["Jun", "June"],
  ["Jul", "July"],
  ["Aug", "August"],
  ["Sep", "Sept", "September"],
  ["Oct", "October"],
  ["Nov", "November"],
  ["Dec", "December"],
];

/** Number of days in a given 1-based month of a given year (UTC-safe). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Zero-pad a 1-2 digit number to exactly 2 characters. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A valid calendar (year, month, day) triple with the year in 1900..2100. The
 * day is constrained to the real length of the chosen month/year so no
 * impossible dates (Feb 30, Apr 31, etc.) are ever produced.
 */
const calendarDate: fc.Arbitrary<{ year: number; month: number; day: number }> =
  fc
    .record({
      year: fc.integer({ min: 1900, max: 2100 }),
      month: fc.integer({ min: 1, max: 12 }),
      dayFraction: fc.integer({ min: 1, max: 31 }),
    })
    .map(({ year, month, dayFraction }) => {
      const maxDay = daysInMonth(year, month);
      // Clamp into the valid range for this month so the date is always real.
      const day = ((dayFraction - 1) % maxDay) + 1;
      return { year, month, day };
    });

/**
 * Render a valid calendar date in one of the accepted formats, using the
 * SEPARATOR the grammar requires for that format (dash vs slash) so the string
 * matches `isDate` exactly.
 */
function renderDate(
  parts: { year: number; month: number; day: number },
  format: DateFormat,
  monthFormIndex: number,
  monthNameLayout: "month-first" | "day-first"
): string {
  const { year, month, day } = parts;
  switch (format) {
    case "iso":
      // YYYY-MM-DD: 4-digit year first, zero-padded, dash-separated.
      return `${year}-${pad2(month)}-${pad2(day)}`;
    case "slash":
      // MM/DD/YYYY: month-first, slash-separated.
      return `${month}/${day}/${year}`;
    case "dash":
      // DD-MM-YYYY: day-first, dash-separated.
      return `${day}-${month}-${year}`;
    case "month-name": {
      const forms = MONTH_FORMS[month - 1];
      const name = forms[monthFormIndex % forms.length];
      // "Jan 5, 2026" (month-first) or "5 Jan 2026" (day-first).
      return monthNameLayout === "month-first"
        ? `${name} ${day}, ${year}`
        : `${day} ${name} ${year}`;
    }
  }
}

/**
 * Generator for a single date string spanning every accepted format. Every
 * produced value is asserted (via a post-filter) to satisfy `isDate`, so the
 * generator can never drift out of sync with the predicate.
 */
const dateLikeString: fc.Arbitrary<string> = fc
  .record({
    parts: calendarDate,
    format: fc.constantFrom<DateFormat>("iso", "slash", "dash", "month-name"),
    monthFormIndex: fc.integer({ min: 0, max: 2 }),
    monthNameLayout: fc.constantFrom<"month-first" | "day-first">(
      "month-first",
      "day-first"
    ),
  })
  .map(({ parts, format, monthFormIndex, monthNameLayout }) =>
    renderDate(parts, format, monthFormIndex, monthNameLayout)
  )
  // Safety net: only keep values the predicate actually accepts. This keeps the
  // generator honest without hand-proving every combination.
  .filter((s) => isDate(s));

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
 * A column of values: at least one date string, plus zero or more NullTokens
 * interleaved at random positions. Guaranteeing one real date keeps the
 * all-NullToken case (task 7.11) out of this property.
 */
const dateColumnWithNullTokens: fc.Arbitrary<CellValue[]> = fc
  .record({
    dates: fc.array(dateLikeString, { minLength: 1, maxLength: 12 }),
    nulls: fc.array(nullTokenValue, { minLength: 0, maxLength: 8 }),
  })
  .chain(({ dates, nulls }) => {
    const combined: CellValue[] = [...dates, ...nulls];
    // Shuffle so NullTokens land at random positions among the dates.
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

describe("Property 17: All-dates infer date", () => {
  it("infers 'date' for a column of only date strings (mixed formats allowed)", () => {
    fc.assert(
      fc.property(
        fc.array(dateLikeString, { minLength: 1, maxLength: 15 }),
        (dates) => {
          // Guard against generator drift: everything must be a real date.
          expect(dates.every(isDate)).toBe(true);
          expect(inferSingleColumnType(dates)).toBe("date");
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("infers 'date' when NullTokens are interleaved with dates (NullTokens excluded)", () => {
    fc.assert(
      fc.property(dateColumnWithNullTokens, (values) => {
        // Precondition for this property: at least one real date is present.
        const present = values.filter((v) => !isNullToken(v));
        expect(present.length).toBeGreaterThan(0);
        expect(present.every(isDate)).toBe(true);

        expect(inferSingleColumnType(values)).toBe("date");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("handles representative dates across every accepted format and layout", () => {
    // Deterministic spot-checks that each accepted surface form, mixed with
    // NullTokens, still infers `date`. Separators pick the order:
    // slash = month-first, dash (with 2-digit lead) = day-first.
    const examples = [
      "2026-02-28", // ISO
      "2024-02-29", // ISO, leap day
      "1/5/2026", // MM/DD/YYYY (month-first, slash)
      "12/31/1999", // MM/DD/YYYY
      "05-01-2026", // DD-MM-YYYY (day-first, dash) → 5 Jan 2026
      "31-12-1999", // DD-MM-YYYY
      "Jan 5, 2026", // month-name, month-first
      "January 5 2026", // month-name, month-first, full name, no comma
      "5 Jan 2026", // month-name, day-first
      "5 September 1999", // month-name, day-first, full name
    ];
    // Every example must be accepted by the predicate (guards against drift).
    for (const ex of examples) {
      expect(isDate(ex)).toBe(true);
    }
    const withNulls: CellValue[] = [
      examples[0],
      null,
      examples[2],
      "N/A",
      examples[4],
      "",
      examples[6],
      "-",
      examples[8],
    ];
    expect(inferSingleColumnType(examples)).toBe("date");
    expect(inferSingleColumnType(withNulls)).toBe("date");
  });
});
