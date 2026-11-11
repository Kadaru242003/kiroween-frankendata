/**
 * Value-coercion helpers for the FrankenData file-intake pipeline (task 7.3).
 *
 * Once the {@link TypeInferenceLayer} has classified a column, the raw string
 * cell values must be coerced into their canonical form before insertion into
 * the explicitly typed DuckDB columns:
 *   - number cells → their numeric value, with currency symbols, thousands
 *     separators, surrounding whitespace stripped and a trailing percent sign
 *     converted to a decimal fraction (`12%` → `0.12`);
 *   - date cells → canonical ISO `YYYY-MM-DD`, regardless of the recognized
 *     source format, idempotent for already-ISO values.
 *
 * These helpers delegate to the per-value grammar in `./predicates` (the
 * shared {@link parseNumericCore} engine and {@link parseDateParts}) so that
 * coercion never diverges from inference: anything `isNumber` accepts,
 * {@link parseNumber} parses to the same value, and anything `isDate` accepts,
 * {@link normalizeDateToIso} normalizes to a valid ISO date.
 */

import { parseDateParts, parseNumericCore } from "./predicates";

/** Default formatting options for {@link formatNumber}. */
export interface FormatNumberOptions {
  /**
   * A currency symbol/word to prepend (e.g. `"$"`, `"€"`, `"EUR"`). Must be one
   * of the prefixes recognized by {@link parseNumber} for the round trip to
   * hold. Omit for no currency symbol.
   */
  currency?: string;
  /** Whether to insert thousands-separator commas into the integer part. */
  thousands?: boolean;
  /** Surrounding whitespace to wrap the formatted string with. */
  whitespace?: string;
}

/**
 * Parse a string into its numeric value, stripping optional surrounding
 * whitespace, a leading currency symbol/word (`$`, `€`, `£`, `₹`, `EUR`,
 * `GBP`, `INR`), thousands-separator commas, and converting an optional
 * trailing percent sign to a decimal fraction (`12%` → `0.12`, Req 5.5).
 *
 * This reuses the exact grammar behind the `isNumber` predicate, so every
 * value `isNumber` accepts is parsed here, and the result agrees with the
 * value stored in a DuckDB `DOUBLE` column.
 *
 * @param value The raw numeric string.
 * @returns The numeric value.
 * @throws {RangeError} If `value` is not a parsable number.
 */
export function parseNumber(value: string): number {
  const n = parseNumericCore(value);
  if (n === null) {
    throw new RangeError(`Not a parsable number: ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Format a number into a string decorated with an optional currency symbol,
 * thousands-separator commas, and surrounding whitespace, such that
 * {@link parseNumber} reverses it exactly:
 * `parseNumber(formatNumber(n, opts)) === n` (Req 10.7, round trip).
 *
 * The number is rendered with JavaScript's default `Number.prototype.toString`
 * so the round trip is lossless; percent formatting is intentionally not
 * offered here because the percent round trip (`n → n*100 + "%"`) can lose
 * precision, and the number round-trip property does not require it.
 *
 * @param value The number to format.
 * @param options Optional currency, thousands, and whitespace decorations.
 * @returns The formatted, round-trippable string.
 */
export function formatNumber(
  value: number,
  options: FormatNumberOptions = {}
): string {
  const { currency, thousands = false, whitespace = "" } = options;

  // Base, lossless string form of the number.
  let body = value.toString();

  if (thousands) {
    body = insertThousandsSeparators(body);
  }

  if (currency) {
    body = `${currency}${body}`;
  }

  return `${whitespace}${body}${whitespace}`;
}

/**
 * Insert thousands-separator commas into the integer portion of a numeric
 * string, leaving the sign, fractional part, and any exponent untouched.
 *
 * Numbers written in scientific notation (containing `e`/`E`) are returned
 * unchanged: grouping their mantissa would not survive a parse round trip and
 * is never produced by real currency data.
 */
function insertThousandsSeparators(numeric: string): string {
  if (/[eE]/.test(numeric)) {
    return numeric;
  }

  const sign = numeric.startsWith("-") || numeric.startsWith("+")
    ? numeric[0]
    : "";
  const unsigned = sign ? numeric.slice(1) : numeric;

  const dotIndex = unsigned.indexOf(".");
  const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? "" : unsigned.slice(dotIndex);

  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${sign}${grouped}${fracPart}`;
}

/**
 * Normalize any recognized date string to canonical ISO `YYYY-MM-DD`
 * (Req 5.7, Clarification 1).
 *
 * Recognized inputs — ISO 8601 (`YYYY-MM-DD`), `MM/DD/YYYY` (month-first;
 * slashes are always read as month/day, never day/month), `DD-MM-YYYY`
 * (day-first, dash-separated), and month-name formats such as `Jan 5, 2026` —
 * are all converted to the correct calendar date in ISO form. An already-ISO
 * value maps to itself, so the normalization is idempotent.
 *
 * This reuses {@link parseDateParts}, the same parser behind the `isDate`
 * predicate, so every value `isDate` accepts normalizes to a valid ISO date.
 *
 * @param value The raw date string.
 * @returns The canonical ISO `YYYY-MM-DD` string.
 * @throws {RangeError} If `value` is not a recognized, valid calendar date.
 */
export function normalizeDateToIso(value: string): string {
  const parts = parseDateParts(value.trim());
  if (parts === null) {
    throw new RangeError(`Not a recognized date: ${JSON.stringify(value)}`);
  }
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
