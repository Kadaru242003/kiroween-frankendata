/**
 * CaseFilePanel: the Autopsy report, themed as a lab case file (Feature 4).
 *
 * Presentational glue over the framework-agnostic engine. It runs
 * `runAutopsy` for the target, renders partial results as they arrive (table
 * basics first, then each column), and shows the health score, the transparent
 * breakdown, table findings, per-column findings, Fix it buttons, and the
 * Markdown and JSON exports. It never modifies a table: "Fix it" only reports
 * the user's intent through `onFixIt`, which App hands to the existing
 * approval flow.
 *
 * Every table name, column name, value, and reason is rendered as a React text
 * node (plain text, never markup). Status is conveyed by text as well as color.
 * Animation is disabled under prefers-reduced-motion (see the CSS).
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { DuckDBService } from "../../core/types";
import { runAutopsy } from "../../core/autopsy/autopsy-engine";
import { toJson, toMarkdown } from "../../core/autopsy/report-export";
import type {
  AutopsyReport,
  AutopsyTarget,
  ColumnFinding,
  FixAction,
} from "../../core/autopsy/types";
import { downloadText, fileStem } from "./download";
import "./CaseFilePanel.css";

export interface CaseFilePanelProps {
  db: DuckDBService;
  target: AutopsyTarget;
  /** False for stitched results: the existing approval flow works on loaded tables only. */
  fixable: boolean;
  onClose: () => void;
  /** Hand a Fix it intent to the existing approval flow. */
  onFixIt: (tableName: string, proposalId: string) => void;
  /** Injection points for tests. */
  runner?: typeof runAutopsy;
  download?: typeof downloadText;
}

/** The verdict word shown on the stamp. */
export function verdictFor(score: number): string {
  if (score >= 90) return "Clean bill of health";
  if (score >= 70) return "Minor ailments";
  if (score >= 40) return "Serious condition";
  return "Critical condition";
}

function fmt(v: number | string | undefined): string {
  if (v === undefined) return "n/a";
  if (typeof v === "string") return v;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** A Fix it button that turns into a disabled "Added" state once clicked. */
function FixButton(props: {
  fix: FixAction;
  added: boolean;
  onFix: (f: FixAction) => void;
}): JSX.Element {
  const { fix, added, onFix } = props;
  return (
    <button
      type="button"
      className={`case-fix__button${added ? " case-fix__button--added" : ""}`}
      aria-label={added ? `Added: ${fix.label}` : `Fix it: ${fix.label}`}
      disabled={added}
      onClick={() => onFix(fix)}
    >
      {added ? "\u2713 Added" : "Fix it"}
    </button>
  );
}
function ColumnCard(props: {
  col: ColumnFinding;
  fixes: FixAction[];
  fixable: boolean;
  onFix: (f: FixAction) => void;
  added: ReadonlySet<string>;
}): JSX.Element {
  const { col, fixes, fixable, onFix, added } = props;
  const hasStats = col.min !== undefined || col.mean !== undefined;
  return (
    <li className={`case-col case-col--${col.status}`}>
      <div className="case-col__head">
        <span className="case-col__name">{col.name}</span>
        <span className="case-col__type">{col.type}</span>
        <span className={`case-badge case-badge--${col.status}`}>
          {col.status.toUpperCase()}
        </span>
      </div>
      <p className="case-col__facts">
        Nulls {col.nullCount} ({col.nullPct.toFixed(1)}%), distinct {col.distinct}
        {hasStats
          ? `, min ${fmt(col.min)}, max ${fmt(col.max)}, mean ${fmt(col.mean)}, median ${fmt(col.median)}`
          : ""}
      </p>
      <details className="case-col__details">
        <summary>Details</summary>
        <ul className="case-col__list">
          {col.topValues && col.topValues.length > 0 ? (
            <li>
              Top values:{" "}
              {col.topValues.map((t) => `${t.value} (${t.count})`).join(", ")}
            </li>
          ) : null}
          {(col.whitespaceRows ?? 0) > 0 ? (
            <li>Rows with stray whitespace: {col.whitespaceRows}</li>
          ) : null}
          {(col.caseVariantGroups ?? 0) > 0 ? (
            <li>Groups that differ only by letter case: {col.caseVariantGroups}</li>
          ) : null}
          {(col.categoryVariants ?? 0) > 0 ? (
            <li>Category variants: {col.categoryVariants}</li>
          ) : null}
          {col.outliers && col.outliers.count > 0 ? (
            <li>
              Outliers: {col.outliers.count}, outside {fmt(col.outliers.lower)} to{" "}
              {fmt(col.outliers.upper)}. Examples: {col.outliers.examples.join(", ")}
            </li>
          ) : null}
          {col.statusReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
      {fixable && fixes.length > 0 ? (
        <div className="case-col__fixes">
          {fixes.map((f) => (
            <span key={f.proposalId} className="case-fix">
              <FixButton fix={f} added={added.has(f.proposalId)} onFix={onFix} />
              <span className="case-fix__label">{f.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function CaseFilePanel({
  db,
  target,
  fixable,
  onClose,
  onFixIt,
  runner = runAutopsy,
  download = downloadText,
}: CaseFilePanelProps): JSX.Element {
  const [report, setReport] = useState<AutopsyReport | null>(null);
  const [attempt, setAttempt] = useState(0);
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    setReport(null);
    void runner(db, target, {
      allowFixes: fixable,
      onProgress: (partial) => {
        if (id === runId.current) setReport(partial);
      },
    }).then((final) => {
      if (id === runId.current) setReport(final);
    });
    return () => {
      // Invalidate this run so a stale result never overwrites a newer one.
      runId.current += 1;
    };
    // The target is identified by its name and row count.
  }, [db, target.tableName, target.rowCount, fixable, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Proposal ids already handed to the approval flow, so a second click cannot
  // add a duplicate. Reset when the panel moves to another table.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAdded(new Set());
    setAnnouncement("");
  }, [target.tableName]);

  const handleFix = useCallback(
    (f: FixAction) => {
      if (added.has(f.proposalId)) return;
      setAdded((prev) => new Set(prev).add(f.proposalId));
      setAnnouncement("Added to the stitching table");
      onFixIt(target.tableName, f.proposalId);
    },
    [onFixIt, target.tableName, added]
  );

  const complete = report?.complete === true && report.status === "ok";
  const stem = fileStem(target.tableName);
  const dupFix = report?.fixes.find((f) => f.kind === "duplicate-rows");

  let status = "Examining the specimen...";
  if (report?.status === "error" || report?.status === "too-large") {
    status = report.message ?? "The autopsy could not be completed.";
  } else if (complete) {
    status = "Autopsy complete";
  } else if (report) {
    status = "Analyzing columns...";
  }

  return (
    <section className="case-file" aria-label="Autopsy case file">
      <header className="case-file__header">
        <div>
          <p className="case-file__label">Case file</p>
          <h2 className="case-file__title">{target.tableName}</h2>
        </div>
        {report?.status === "ok" ? (
          <div className="case-stamp" aria-label={`Health score ${report.health.score} out of 100`}>
            <span className="case-stamp__score">{report.health.score}</span>
            <span className="case-stamp__max">/ 100</span>
            <span className="case-stamp__verdict">{verdictFor(report.health.score)}</span>
          </div>
        ) : null}
        <button type="button" className="case-file__close" onClick={onClose}>
          Close
        </button>
      </header>

      <p className="case-file__sr" aria-live="polite" data-testid="fixit-live">
        {announcement}
      </p>
      <p className="case-file__status" role="status" aria-live="polite">
        {status}
      </p>

      {report?.status === "error" || report?.status === "too-large" ? (
        <div className="case-file__problem">
          {report.status === "error" ? (
            <button type="button" className="case-file__retry" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {report?.status === "ok" ? (
        <>
          <section className="case-section" aria-label="Score breakdown">
            <h3 className="case-section__title">Score breakdown</h3>
            {report.health.breakdown.length === 0 ? (
              <p className="case-section__empty">No deductions.</p>
            ) : (
              <ul className="case-breakdown">
                {report.health.breakdown.map((d) => (
                  <li key={d.code}>
                    <span className="case-breakdown__points">-{d.points}</span> {d.reason}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="case-section" aria-label="Table findings">
            <h3 className="case-section__title">Table findings</h3>
            <ul className="case-facts">
              <li>
                Rows: {report.rows}. Columns: {report.columnCount}.
              </li>
              <li>
                Exact duplicate rows: {report.duplicateRows}
                {fixable && dupFix ? (
                  <span className="case-fix">
                    <FixButton
                      fix={dupFix}
                      added={added.has(dupFix.proposalId)}
                      onFix={handleFix}
                    />
                    <span className="case-fix__label">{dupFix.label}</span>
                  </span>
                ) : null}
              </li>
              <li>
                Candidate key columns:{" "}
                {report.candidateKeys.length > 0 ? report.candidateKeys.join(", ") : "none"}
              </li>
              <li>
                All-null columns:{" "}
                {report.allNullColumns.length > 0 ? report.allNullColumns.join(", ") : "none"}
              </li>
              <li>
                Constant columns:{" "}
                {report.constantColumns.length > 0 ? report.constantColumns.join(", ") : "none"}
              </li>
            </ul>
            {!fixable ? (
              <p className="case-section__note">
                This is a stitched result, shown read-only. Fix it is available for original tables.
              </p>
            ) : null}
          </section>

          <section className="case-section" aria-label="Column findings">
            <h3 className="case-section__title">Column findings</h3>
            <ul className="case-cols">
              {report.columns.map((c) => (
                <ColumnCard
                  key={c.name}
                  col={c}
                  fixes={report.fixes.filter((f) => f.columnName === c.name)}
                  fixable={fixable}
                  onFix={handleFix}
                  added={added}
                />
              ))}
            </ul>
          </section>

          <footer className="case-file__footer">
            <button
              type="button"
              className="case-file__export"
              disabled={!complete}
              onClick={() => download(`autopsy-${stem}.md`, "text/markdown", toMarkdown(report))}
            >
              Download Markdown
            </button>
            <button
              type="button"
              className="case-file__export"
              disabled={!complete}
              onClick={() => download(`autopsy-${stem}.json`, "application/json", toJson(report))}
            >
              Download JSON
            </button>
          </footer>
        </>
      ) : null}
    </section>
  );
}

export default CaseFilePanel;
