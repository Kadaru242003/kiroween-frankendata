/**
 * Redact a DuckDB error message before it goes into a repair request
 * (security-hardening, commit B).
 *
 * DuckDB errors often quote the offending cell value, for example
 * `Conversion Error: Could not convert string 'N/A-4821' to INT32`. A repair
 * request must never carry cell values, so before it is sent:
 *
 *   1. only the first line is kept (the error type and message; the `LINE n:`
 *      context, caret and candidate lists that follow are dropped);
 *   2. everything inside single or double quotes becomes `'<value>'`;
 *   3. bare numbers become `<number>` (an out-of-range cast prints its value
 *      without quotes), while type names such as INT32 are left alone;
 *   4. the result is cut to ASK_REPAIR_ERROR_MAX_CHARS characters.
 *
 * Quote handling is deliberately conservative. A quote only OPENS a value when
 * it is not glued to a word (so the apostrophe in "can't" is text), and a quote
 * only CLOSES it when it is not followed by a word character (so the value in
 * `'O'Brien'` is redacted whole). An unterminated quote redacts to the end.
 * Pure and total: it never throws.
 */

import { ASK_REPAIR_ERROR_MAX_CHARS } from "./types.js";

const PLACEHOLDER = "'<value>'";
const WORD = /\w/;

/** Replace every quoted span with {@link PLACEHOLDER}. */
function redactQuoted(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const opens = (c === "'" || c === '"') && (i === 0 || !WORD.test(text[i - 1]));
    if (!opens) {
      out += c;
      i++;
      continue;
    }
    let j = i + 1;
    let closed = false;
    while (j < n) {
      if (text[j] === c) {
        const next = text[j + 1];
        if (next === c) {
          j += 2; // doubled quote is an escaped quote
          continue;
        }
        if (next !== undefined && WORD.test(next)) {
          j++; // a quote glued to a word belongs to the value
          continue;
        }
        closed = true;
        break;
      }
      j++;
    }
    out += PLACEHOLDER;
    i = closed ? j + 1 : n;
  }
  return out;
}

/** Mask bare numbers that are not part of a word such as INT32. */
function maskNumbers(text: string): string {
  return text.replace(/(?<![\w.<])-?\d+(?:\.\d+)?(?![\w>])/g, "<number>");
}

/** Redact a DuckDB error message for a repair request. */
export function redactDuckDbError(message: string): string {
  const firstLine = String(message ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "Error";
  // Numbers first: quote redaction then sees the final text, which keeps the
  // whole function idempotent (a second pass changes nothing).
  const redacted = redactQuoted(maskNumbers(firstLine)).trim();
  if (redacted.length === 0) return "Error";
  return redacted.slice(0, ASK_REPAIR_ERROR_MAX_CHARS);
}
