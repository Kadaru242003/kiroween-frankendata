/**
 * MatchDiff — renders a single {@link MatchProposal} as a before/after diff with
 * per-proposal approve / reject / edit controls (Feature 2, task 13; design "UI
 * Layer / MatchDiff", Req 3.1, 3.2, 3.6, 6.8).
 *
 * A match proposal pairs a column in one table with a column in another. The
 * "diff" here is the proposed pairing: the left column (before) ↔ the right
 * column (after), with the confidence and the one-line reason. Editing a match
 * means **re-pairing to a different column in the *other* table** (Req 3.6): the
 * left column stays fixed and the user picks a different `right` column from the
 * same right-hand table via a native `<select>`. Choosing a new column records
 * an `edited` decision whose `edit` overrides `right` (and re-stamps the `id`
 * and `type` to keep the proposal coherent).
 *
 * ## Security — plain text only (Req 6.8 / design "All AI-provided text rendered
 * as plain text, never markup")
 *
 * The `reason` string (which may originate from the AI) and every column name
 * are rendered as React children (text nodes). React escapes them, so no HTML or
 * markdown in the string is ever interpreted. This component never uses
 * `dangerouslySetInnerHTML`.
 *
 * Presentational only: it reports the user's decision through callbacks and
 * holds no cross-proposal state. The {@link ApprovalScreen} owns the decisions
 * map and the plan assembly.
 */

import { type JSX } from "react";
import type { ColumnSchema } from "../../core/types";
import type {
  DecisionKind,
  MatchProposal,
} from "../../core/stitching/types";
import { EngineBadge } from "./EngineBadge";

/** A loaded table's name + schema, used to offer re-pair target columns. */
export interface MatchDiffTable {
  tableName: string;
  schema: ColumnSchema[];
}

/** Props for {@link MatchDiff}. */
export interface MatchDiffProps {
  /** The proposal to render (already merged with any prior edit). */
  proposal: MatchProposal;
  /**
   * The current decision for this proposal, or `undefined` when undecided. Used
   * to reflect the active state on the approve/reject buttons.
   */
  decision?: DecisionKind;
  /**
   * The loaded tables, so the edit control can list the candidate columns in the
   * *other* table (the right-hand table) to re-pair to (Req 3.6).
   */
  tables: readonly MatchDiffTable[];
  /** Approve this proposal as-is (Req 3.2). */
  onApprove: (proposalId: string) => void;
  /** Reject this proposal (Req 3.2). */
  onReject: (proposalId: string) => void;
  /**
   * Re-pair the match to a different `right` column in the same right-hand table
   * (Req 3.6). The screen records this as an `edited` decision.
   */
  onRepair: (proposalId: string, nextRightColumnName: string) => void;
}

/** Render a 0..1 confidence as a compact percentage string (plain text). */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * A single match proposal rendered as a before/after column pairing with
 * approve / reject / re-pair controls and an engine badge.
 */
export function MatchDiff({
  proposal,
  decision,
  tables,
  onApprove,
  onReject,
  onRepair,
}: MatchDiffProps): JSX.Element {
  const { id, left, right, confidence, reason, source, aiDiscovered } = proposal;

  // Candidate re-pair columns: every column in the right-hand table (Req 3.6 —
  // re-pair to a different column in the *other* table). The left column stays
  // fixed; the user swaps which right column it pairs with.
  const rightTable = tables.find((t) => t.tableName === right.tableName);
  const repairOptions = rightTable?.schema ?? [];

  const selectId = `match-repair-${id}`;

  return (
    <article
      className="stitch-proposal stitch-proposal--match"
      aria-label={`Match proposal ${left.columnName} to ${right.columnName}`}
    >
      <header className="stitch-proposal__header">
        <h4 className="stitch-proposal__title">Column match</h4>
        <EngineBadge source={source} />
        {/*
          "AI found this" chip (enhancement): shown only when the AI
          DISCOVERED this match — its rule score was below the display
          threshold and the bounded lift brought it to visible. Fixed in-code
          label, rendered as a plain text node.
        */}
        {aiDiscovered ? (
          <span
            className="stitch-ai-found"
            aria-label="Discovered by AI"
          >
            AI found this
          </span>
        ) : null}
        <span className="stitch-proposal__confidence" aria-label="Confidence">
          {formatConfidence(confidence)}
        </span>
      </header>

      <div className="stitch-diff">
        <div className="stitch-diff__side stitch-diff__side--before">
          <span className="stitch-diff__label">Before</span>
          <span className="stitch-diff__value">
            {left.tableName}.{left.columnName}
          </span>
          <span className="stitch-diff__type">{left.type}</span>
        </div>
        <span className="stitch-diff__arrow" aria-hidden="true">
          →
        </span>
        <div className="stitch-diff__side stitch-diff__side--after">
          <span className="stitch-diff__label">After</span>
          <span className="stitch-diff__value">
            {right.tableName}.{right.columnName}
          </span>
          <span className="stitch-diff__type">{right.type}</span>
        </div>
      </div>

      {/* reason may come from the AI — rendered as a plain text node (Req 6.8). */}
      <p className="stitch-proposal__reason">{reason}</p>

      <div className="stitch-proposal__edit">
        <label className="stitch-proposal__edit-label" htmlFor={selectId}>
          Re-pair {left.columnName} to
        </label>
        <select
          id={selectId}
          className="stitch-proposal__select"
          value={right.columnName}
          onChange={(e) => onRepair(id, e.target.value)}
        >
          {repairOptions.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name}
            </option>
          ))}
        </select>
      </div>

      <div className="stitch-proposal__actions">
        <button
          type="button"
          className="stitch-proposal__action stitch-proposal__action--approve"
          aria-pressed={decision === "approved"}
          onClick={() => onApprove(id)}
        >
          Approve
        </button>
        <button
          type="button"
          className="stitch-proposal__action stitch-proposal__action--reject"
          aria-pressed={decision === "rejected"}
          onClick={() => onReject(id)}
        >
          Reject
        </button>
      </div>
    </article>
  );
}

export default MatchDiff;
