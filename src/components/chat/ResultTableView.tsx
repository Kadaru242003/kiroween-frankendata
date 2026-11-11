/**
 * ResultTableView — renders a query result as a table with a "showing N of M"
 * note and a full-CSV download (Feature 3, task 6; Req 1.6, 1.7, 7.5).
 *
 * Presentational only. It receives already-converted {@link DisplayValue}s from
 * the AskController (so no BigInt/Date/object ever reaches the DOM), renders at
 * most {@link ASK_RESULT_DISPLAY_CAP} rows on screen with a note when the full
 * result is larger, and offers a CSV download of the ENTIRE result (not just
 * the displayed rows) built by {@link toCsv}. Every cell and header is rendered
 * as PLAIN TEXT (Req 9.5).
 *
 * The CSV download uses an object URL created on click and revoked after, so no
 * blob leaks; it degrades to a no-op if the browser lacks URL/Blob (tests).
 */

import { useCallback } from "react";
import {
  ASK_RESULT_DISPLAY_CAP,
  ASK_MAX_FETCH_ROWS,
  type DisplayValue,
} from "../../core/chat/types";
import { toCsv } from "../../core/chat/csv-export";
import "./ResultTableView.css";

export interface ResultTableViewProps {
  columns: string[];
  /** Full result rows (already converted to display values). */
  rows: DisplayValue[][];
  /** True when the fetch hit ASK_MAX_FETCH_ROWS (result is capped). */
  capped: boolean;
}

export const DOWNLOAD_CSV_LABEL = "Download CSV";

/** Render a display value as text (DisplayValue is always string|number|boolean). */
function cellText(value: DisplayValue): string {
  return typeof value === "string" ? value : String(value);
}

export function ResultTableView({ columns, rows, capped }: ResultTableViewProps) {
  const total = rows.length;
  const shown = Math.min(total, ASK_RESULT_DISPLAY_CAP);
  const displayRows = rows.slice(0, ASK_RESULT_DISPLAY_CAP);

  const handleDownload = useCallback(() => {
    try {
      const csv = toCsv(columns, rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ask-the-lab-result.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Non-fatal: a missing Blob/URL (or a blocked download) must not crash.
    }
  }, [columns, rows]);

  const note = capped
    ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} rows (result capped at ${ASK_MAX_FETCH_ROWS.toLocaleString()}).`
    : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "row" : "rows"}.`;

  return (
    <section className="ask-result" aria-label="Query result">
      <div className="ask-result__toolbar">
        <p className="ask-result__note">{note}</p>
        <button
          type="button"
          className="ask-result__download"
          onClick={handleDownload}
          disabled={total === 0}
        >
          {DOWNLOAD_CSV_LABEL}
        </button>
      </div>

      <div className="ask-result__scroll">
        <table className="ask-result__table">
          <thead className="ask-result__thead">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="ask-result__th">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td className="ask-result__empty" colSpan={Math.max(columns.length, 1)}>
                  No rows
                </td>
              </tr>
            ) : (
              displayRows.map((row, ri) => (
                <tr key={ri}>
                  {columns.map((_c, ci) => (
                    <td key={ci} className="ask-result__td">
                      {cellText(row[ci])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default ResultTableView;
