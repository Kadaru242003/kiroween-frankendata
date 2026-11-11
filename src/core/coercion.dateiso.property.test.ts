/**
 * Property-based tests for date normalization to canonical ISO YYYY-MM-DD.
 *
 * Feature: frankendata-file-intake, Property 29: Date normalization to ISO
 * YYYY-MM-DD
 *
 * Validates: Requirements 4.5, 5.7
 *
 * Property 29 statement: Any recognized date format — ISO 8601 (`YYYY-MM-DD`),
 * `MM/DD/YYYY` (month-first; slashes read as month/day, never day/month),
 * `DD-MM-YYYY` (day-first, dash-separated), month-name — normalizes to the
 * canonical ISO `YYYY-MM-DD`; normalization is idempotent for already-ISO
 * values.
 *
 * The function under test is {@link normalizeDateToIso} from `coercion.ts`,
 * which delegates to `parseDateParts` (the same parser behind the `isDate`
 * predicate in `predicates.ts`) and zero-pads the result to `YYYY-MM-DD`.
 *
 * ## Matching the grammar exactly (predicates.ts `parseDateParts`)
 *
 * Each accepted surface form is rendered with the SEPARATOR the grammar
 * requires so the rendered string is accepted by `isDate`:
 *   - ISO `YYYY-MM-DD`: 4-digit year first, 2-digit zero-padded month/day,
 *     dash-separated. This is also the canonical output form.
 *   - `MM/DD/YYYY`: month-FIRST, SLASH-separated. The grammar accepts 1-2 digit
 *     month/day (`\d{1,2}`), so we exercise single-digit (unpadded) renderings.
 *   - `DD-MM-YYYY`: day-FIRST, DASH-separated, 1-2 digit day/month, 4-digit year
 *     LAST (which distinguishes it from ISO where the 4-digit year is FIRST).
 *   - Month-name: `"Jan 5, 2026"` / `"January 5 2026"` (month-first) and
 *     `"5 Jan 2026"` / `"5 September 1999"` (day-first).
 *
 * The expected canonical ISO string is computed directly from the generated
 * calendar triple (zero-padded), independent of the rendering, so the assertion
 * `normalizeDateToIso(rendered) === expectedISO` holds for every format.
 *
 * Only valid calendar dates are generated (real month lengths + leap years),
 * years in 1900..2100, so the padded year is always 4 digits and never needs a
 * left-pad beyond its natural width. Every rendered value is asserted (via a
 * post-filter on the strategy) to satisfy `isDate`, so the generator can never
 * drift out of sync with the predicate.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { normalizeDateToIso } from "./coercion";
import { isDate } from "./predicates";

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

/** Zero-pad a number to exactly `width` characters. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** A resolved calendar date triple (month and day are 1-based). */
interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * A valid calendar (year, month, day) triple with the year in 1900..2100. The
 * day is clamped to the real length of the chosen month/year so no impossible
 * dates (Feb 30, Apr 31, non-leap Feb 29, etc.) are ever produced.
 */
const calendarDate: fc.Arbitrary<CalendarDate> = fc
  .record({
    year: fc.integer({ min: 1900, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayFraction: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, dayFraction }) => {
    const maxDay = daysInMonth(year, month);
    const day = ((dayFraction - 1) % maxDay) + 1;
    return { year, month, day };
  });

/** The canonical ISO `YYYY-MM-DD` string for a calendar triple (zero-padded). */
function expectedIso(parts: CalendarDate): string {
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

/**
 * Render a valid calendar date in one of the accepted formats, using the
 * SEPARATOR the grammar requires for that format (dash vs slash). The slash and
 * dash numeric forms use single-digit (unpadded) month/day to exercise the
 * grammar's `\d{1,2}` acceptance; ISO uses the required 2-digit zero-padded
 * month/day.
 */
function renderDate(
  parts: CalendarDate,
  format: DateFormat,
  monthFormIndex: number,
  monthNameLayout: "month-first" | "day-first"
): string {
  const { year, month, day } = parts;
  switch (format) {
    case "iso":
      // YYYY-MM-DD: 4-digit year first, zero-padded month/day, dash-separated.
      return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
    case "slash":
      // MM/DD/YYYY: month-first, slash-separated (unpadded month/day allowed).
      return `${month}/${day}/${year}`;
    case "dash":
      // DD-MM-YYYY: day-first, dash-separated (unpadded day/month allowed).
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
 * A single (calendar date, rendered string) pair spanning every accepted
 * format. Every rendered value is asserted (via a post-filter) to satisfy
 * `isDate`, so the generator can never drift out of sync with the predicate.
 */
const renderedDate: fc.Arbitrary<{ parts: CalendarDate; rendered: string }> = fc
  .record({
    parts: calendarDate,
    format: fc.constantFrom<DateFormat>("iso", "slash", "dash", "month-name"),
    monthFormIndex: fc.integer({ min: 0, max: 2 }),
    monthNameLayout: fc.constantFrom<"month-first" | "day-first">(
      "month-first",
      "day-first"
    ),
  })
  .map(({ parts, format, monthFormIndex, monthNameLayout }) => ({
    parts,
    rendered: renderDate(parts, format, monthFormIndex, monthNameLayout),
  }))
  // Safety net: only keep values the predicate actually accepts.
  .filter(({ rendered }) => isDate(rendered));

describe("Property 29: Date normalization to ISO YYYY-MM-DD", () => {
  it("normalizes any recognized format to the canonical ISO YYYY-MM-DD", () => {
    fc.assert(
      fc.property(renderedDate, ({ parts, rendered }) => {
        // Guard against generator drift: the rendering must be a real date.
        expect(isDate(rendered)).toBe(true);
        expect(normalizeDateToIso(rendered)).toBe(expectedIso(parts));
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("is idempotent on already-ISO values (ISO input maps to itself)", () => {
    fc.assert(
      fc.property(calendarDate, (parts) => {
        const iso = expectedIso(parts);
        expect(isDate(iso)).toBe(true);
        expect(normalizeDateToIso(iso)).toBe(iso);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("is idempotent under re-normalization for any recognized format", () => {
    fc.assert(
      fc.property(renderedDate, ({ rendered }) => {
        const once = normalizeDateToIso(rendered);
        expect(normalizeDateToIso(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("normalizes representative dates across every accepted format", () => {
    // Deterministic spot-checks: each surface form maps to the same ISO date.
    const cases: Array<[string, string]> = [
      ["2026-02-28", "2026-02-28"], // ISO
      ["2024-02-29", "2024-02-29"], // ISO, leap day
      ["1/5/2026", "2026-01-05"], // MM/DD/YYYY (month-first, slash), unpadded
      ["12/31/1999", "1999-12-31"], // MM/DD/YYYY
      ["05-01-2026", "2026-01-05"], // DD-MM-YYYY (day-first, dash) → 5 Jan 2026
      ["5-1-2026", "2026-01-05"], // DD-MM-YYYY, unpadded
      ["31-12-1999", "1999-12-31"], // DD-MM-YYYY
      ["Jan 5, 2026", "2026-01-05"], // month-name, month-first
      ["January 5 2026", "2026-01-05"], // month-name, full name, no comma
      ["5 Jan 2026", "2026-01-05"], // month-name, day-first
      ["5 September 1999", "1999-09-05"], // month-name, day-first, full name
    ];
    for (const [input, iso] of cases) {
      expect(isDate(input)).toBe(true);
      expect(normalizeDateToIso(input)).toBe(iso);
      // Idempotence on the canonical output.
      expect(normalizeDateToIso(iso)).toBe(iso);
    }
  });
});
