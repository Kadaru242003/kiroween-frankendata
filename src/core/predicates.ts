/**
 * Per-value parseability predicates for the FrankenData type-inference layer.
 *
 * Each predicate answers a single yes/no question about one cell value:
 * is it a missing-value marker, a number, a boolean, or a date? The
 * TypeInferenceLayer (task 7.2) classifies a whole column by excluding
 * `NullToken` values and then checking whether the remaining values all
 * satisfy one of these predicates.
 *
 * Mutual exclusivity is a design invariant (design.md, "Per-value
 * parseability predicates"): over any single value at most one of
 * `isNumber` / `isBoolean` / `isDate` is true, and a `NullToken` is none of
 * them. This keeps the column-classification order unambiguous for uniform
 * columns. The predicates are built so their recognized grammars do not
 * overlap:
 *   - bare `0` / `1` are numbers, never booleans;
 *   - a bare 4-digit year (`2023`) is a number, never a date;
 *   - a lone `-` is a NullToken, never a number;
 *   - the date formats always contain a separator or a month name, so they
 *     never match a pure numeric string.
 *
 * All predicates accept {@link CellValue} (`string | null`). `isNullToken`
 * treats `null` as a null token; the other predicates return `false` for
 * `null` (a missing value is not a number/boolean/date).
 */

import type { CellValue } from "./types";

/** The literal text tokens (compared case-insensitively after trim) that mark a missing value, besides empty/whitespace cells. */
const NULL_TOKEN_TEXTS = new Set(["n/a", "na", "null", "-"]);

/** Leading currency symbols and currency words stripped by {@link isNumber}. */
const CURRENCY_PREFIXES = ["$", "€", "£", "₹", "EUR", "GBP", "INR"];

/** Case-insensitive boolean literals recognized by {@link isBoolean}. */
const BOOLEAN_PATTERN = /^(?:true|false|yes|no)$/i;

/** Month abbreviations/names → 1-based month number, used by the month-name date parser. */
const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Whether a cell value is a `NullToken` — a marker for missing data.
 *
 * Recognized (case-insensitive, after trimming surrounding whitespace):
 * `null` (the JS value), an empty or whitespace-only string, and the literal
 * texts `N/A`, `NA`, `null`, or a single hyphen `-` (Req 5.2).
 *
 * @param value The raw cell value.
 * @returns `true` if the value represents missing data.
 */
export function isNullToken(value: CellValue): boolean {
  if (value === null) {
    return true;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return true;
  }
  return NULL_TOKEN_TEXTS.has(trimmed.toLowerCase());
}

/**
 * Whether a cell value parses as a number (Req 5.4).
 *
 * After trimming, the value may carry an optional leading currency symbol or
 * currency word (`$`, `€`, `£`, `₹`, `EUR`, `GBP`, `INR`), thousands-separator
 * commas, and an optional single trailing percent sign. The remaining core
 * must be a finite decimal (optionally signed, optionally with a fractional
 * part and/or scientific-notation exponent). Bare numeric strings such as
 * `42`, `-3.14`, `1e3`, and `0` also satisfy this.
 *
 * A `NullToken` is never a number, so a lone `-` (a null token) returns
 * `false` even though it carries a sign.
 *
 * @param value The raw cell value.
 * @returns `true` if the value parses as a number.
 */
export function isNumber(value: CellValue): boolean {
  if (value === null) {
    return false;
  }
  // A null token (incl. the lone "-") is never a number; this keeps the
  // predicates mutually exclusive.
  if (isNullToken(value)) {
    return false;
  }
  return parseNumericCore(value) !== null;
}

/**
 * Parse the numeric core of a value after stripping currency, commas, and a
 * trailing percent sign. Returns `null` when the value is not a valid number.
 *
 * This is the shared engine behind {@link isNumber}; value-coercion helpers
 * (task 7.3, `./coercion`) build on the exact same stripping rules so that
 * anything {@link isNumber} accepts, `parseNumber` parses to the same value.
 * A trailing percent sign converts the value to its decimal fraction
 * (`12%` → `0.12`).
 *
 * @param value The raw cell value (not yet trimmed).
 * @returns The numeric value, or `null` if `value` is not a valid number.
 */
export function parseNumericCore(value: string): number | null {
  let s = value.trim();
  if (s === "") {
    return null;
  }

  // Strip a single optional trailing percent sign. A percent value is
  // converted to its decimal fraction below (`12%` → `0.12`, Req 5.5).
  let isPercent = false;
  if (s.endsWith("%")) {
    isPercent = true;
    s = s.slice(0, -1).trim();
  }

  // Strip a single optional leading currency symbol/word (case-insensitive for
  // the word forms). Only one prefix is allowed.
  for (const prefix of CURRENCY_PREFIXES) {
    if (s.toUpperCase().startsWith(prefix.toUpperCase())) {
      s = s.slice(prefix.length).trim();
      break;
    }
  }

  if (s === "") {
    return null;
  }

  // Remove thousands-separator commas. We accept commas liberally here; the
  // strict decimal pattern below is what actually validates the number.
  const withoutCommas = s.replace(/,/g, "");

  // A strict finite-decimal pattern: optional sign, digits with optional
  // fraction (or a leading-dot fraction), optional exponent. This rejects
  // stray characters, lone signs, and bare dots.
  const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!DECIMAL.test(withoutCommas)) {
    return null;
  }

  const n = Number(withoutCommas);
  if (!Number.isFinite(n)) {
    return null;
  }
  // Trailing percent sign → decimal fraction (Req 5.5).
  return isPercent ? n / 100 : n;
}

/**
 * Whether a cell value is a boolean literal (Req 5.6).
 *
 * Matches `true`, `false`, `yes`, or `no` case-insensitively after trimming.
 * Bare `0`/`1` are deliberately NOT booleans (they are numbers), which keeps
 * the predicates mutually exclusive.
 *
 * @param value The raw cell value.
 * @returns `true` if the value is a recognized boolean literal.
 */
export function isBoolean(value: CellValue): boolean {
  if (value === null) {
    return false;
  }
  return BOOLEAN_PATTERN.test(value.trim());
}

/**
 * Whether a cell value is a date (Req 5.7).
 *
 * The value must match one of the recognized formats AND parse to a real
 * calendar date:
 *   - ISO 8601 `YYYY-MM-DD` (year-first, dash-separated);
 *   - `MM/DD/YYYY` (month-first, slash-separated — slashes are always read as
 *     month/day, never day/month);
 *   - `DD-MM-YYYY` (day-first, dash-separated — distinguished from ISO by the
 *     2-digit leading day vs ISO's 4-digit leading year);
 *   - a month-name format such as `Jan 5, 2026`.
 *
 * Invalid calendar dates (e.g. `2026-02-30`, `13/45/2026`) return `false`. A
 * bare 4-digit year like `2023` is NOT a date — it is a number.
 *
 * @param value The raw cell value.
 * @returns `true` if the value is a valid date in a recognized format.
 */
export function isDate(value: CellValue): boolean {
  if (value === null) {
    return false;
  }
  return parseDateParts(value.trim()) !== null;
}

/** A resolved year/month/day triple (month is 1-based). */
interface DateParts {
  year: number;
  month: number;
  day: number;
}

/**
 * Parse a trimmed string into calendar {@link DateParts} if it matches a
 * recognized date format and forms a valid calendar date; otherwise `null`.
 * Exposed for the date-to-ISO coercion helper (task 7.3) to reuse.
 */
export function parseDateParts(trimmed: string): DateParts | null {
  if (trimmed === "") {
    return null;
  }

  // ISO 8601: YYYY-MM-DD (4-digit year first).
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    return validate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // MM/DD/YYYY: month-first, slash-separated.
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash) {
    return validate(Number(slash[3]), Number(slash[1]), Number(slash[2]));
  }

  // DD-MM-YYYY: day-first, dash-separated. The 4-digit year is last, which
  // distinguishes this from ISO (where the 4-digit year is first).
  const dash = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(trimmed);
  if (dash) {
    return validate(Number(dash[3]), Number(dash[2]), Number(dash[1]));
  }

  // Month-name format: "Jan 5, 2026" / "January 5 2026" / "5 Jan 2026".
  const monthFirst = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(trimmed);
  if (monthFirst) {
    const month = MONTH_NAMES[monthFirst[1].toLowerCase()];
    if (month !== undefined) {
      return validate(Number(monthFirst[3]), month, Number(monthFirst[2]));
    }
    return null;
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(trimmed);
  if (dayFirst) {
    const month = MONTH_NAMES[dayFirst[2].toLowerCase()];
    if (month !== undefined) {
      return validate(Number(dayFirst[3]), month, Number(dayFirst[1]));
    }
    return null;
  }

  return null;
}

/**
 * Validate a year/month/day triple as a real calendar date (accounting for
 * month lengths and leap years). Returns the parts on success, else `null`.
 */
function validate(year: number, month: number, day: number): DateParts | null {
  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

/** Number of days in a given 1-based month of a given year. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
