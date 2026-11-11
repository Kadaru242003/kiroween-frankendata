/**
 * CSV export for "Ask the Lab" results (Feature 3, task 3).
 *
 * {@link toCsv} serializes the FULL result (header + every row, not just the
 * on-screen display cap) with RFC-4180 quoting so values containing commas,
 * double quotes, or newlines round-trip through any conformant CSV parser
 * (Req 7.5, 7.6). It consumes already-converted {@link DisplayValue}s (from
 * `result-convert.ts`), so a cell is only ever a string, number, or boolean —
 * never a BigInt/Date/object that could throw.
 *
 * Pure function — no DuckDB, no network, no file I/O (the browser download is
 * wired at the UI edge in a later task).
 */

import type { DisplayValue } from "./types.js";

const CRLF = "\r\n";

/** Does a field need quoting? (contains comma, quote, CR, or LF) */
function needsQuoting(field: string): boolean {
  return (
    field.includes(",") ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  );
}

/** Quote one field per RFC 4180: wrap in quotes and double any inner quote. */
function quoteField(value: DisplayValue): string {
  const s = typeof value === "string" ? value : String(value);
  if (!needsQuoting(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Serialize columns + rows to an RFC-4180 CSV string (CRLF line endings).
 *
 * @param columns Header names, in order.
 * @param rows    Rows of {@link DisplayValue}s aligned with `columns`. This is
 *   the FULL result (bounded only by the executor's ASK_MAX_FETCH_ROWS), not
 *   the display cap.
 */
export function toCsv(columns: string[], rows: DisplayValue[][]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => quoteField(c)).join(","));
  for (const row of rows) {
    lines.push(row.map((cell) => quoteField(cell)).join(","));
  }
  return lines.join(CRLF);
}
