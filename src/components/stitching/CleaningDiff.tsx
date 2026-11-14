/**
 * CleaningDiff — renders a single {@link CleaningProposal} as a before/after
 * diff with per-proposal approve / reject / edit controls (Feature 2, task 13;
 * design "UI Layer / CleaningDiff", Req 3.1, 3.2, 3.7, 6.8).
 *
 * A cleaning proposal describes one deterministic cleanup of a table/column:
 * whitespace/case normalization, category standardization, duplicate-row
 * removal, or number-column outlier flagging. The diff shows the representative
 * `before` and `after` values the engine computed.
 *
 * ## Edit semantics (Req 3.7)
 *
 * Only **category-standardize** proposals are editable, and the single editable
 * field is the target **canonical value** (the surface form every variant maps
 * to). The user types a new canonical into a text input; committing it records
 * an `edited` decision whose `edit` overrides `canonical`. No other cleaning
 * kind exposes an edit control.
 *
 * ## Security — plain text only (Req 6.8)
 *
 * The `reason`, the `before`/`after` representative values, the canonical value,
 * and every variant string are rendered as React text nodes, so React escapes
 * them and no embedded HTML/markdown is ever interpreted. This component never
 * uses `dangerouslySetInnerHTML`. The user-edited canonical is likewise only
 * ever read back as a value and later escaped by the SQL layer (`quoteString`)
 * at apply time; nothing here interprets it as markup.
 */

import { useEffect, useState, type JSX } from "react";
import type {
  CleaningKind,
  CleaningProposal,
  DecisionKind,
} from "../../core/stitching/types";
import { EngineBadge } from "./EngineBadge";

/** Props for {@link CleaningDiff}. */
export interface CleaningDiffProps {
  /** The proposal to render (already merged with any prior edit). */
  proposal: CleaningProposal;
  /** The current decision, or `undefined` when undecided. */
  decision?: DecisionKind;
  /** Approve this proposal (Req 3.2). */
  onApprove: (proposalId: string) => void;
  /** Reject this proposal (Req 3.2). */
  onReject: (proposalId: string) => void;
  /**
   * Change the canonical value of a category-standardize proposal (Req 3.7).
   * The screen records this as an `edited` decision.
   */
  onEditCanonical: (proposalId: string, nextCanonical: string) => void;
}

/** Human-friendly titles for each cleaning kind (fixed, in-code strings). */
const KIND_TITLE: Record<CleaningKind, string> = {
  "whitespace-case": "Whitespace & case",
  "category-standardize": "Category standardize",
  "duplicate-rows": "Duplicate rows",
  outliers: "Outlier flag",
};

/**
 * A `before`/`after` payload shaped as a row-count snapshot, used by the
 * `duplicate-rows` proposal (`{ rowCount }`).
 */
function isRowCountValue(value: unknown): value is { rowCount: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "rowCount" in value &&
    typeof (value as { rowCount: unknown }).rowCount === "number"
  );
}

/**
 * A `before`/`after` payload shaped as an outlier-flag snapshot, used by the
 * `outliers` proposal (`{ outliersFlagged, nonNull }`).
 */
function isOutlierValue(value: unknown): value is { outliersFlagged: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "outliersFlagged" in value &&
    typeof (value as { outliersFlagged: unknown }).outliersFlagged === "number"
  );
}

/** A human-friendly "N row" / "N rows" count label (plain text). */
function rowCountLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;
}

/**
 * Render an arbitrary representative `before`/`after` value as a plain string.
 *
 * The engine stores these as `unknown`. Row-based proposals carry a structured
 * payload rather than a scalar: `duplicate-rows` uses `{ rowCount }` and
 * `outliers` uses `{ outliersFlagged, nonNull }`. Those are turned into a
 * readable count label (e.g. "8 rows", "2 flagged") instead of the useless
 * "[object Object]" that `String({...})` would produce. Everything else is
 * stringified defensively so the output is always a plain text node (never
 * markup).
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isRowCountValue(value)) {
    return rowCountLabel(value.rowCount);
  }
  if (isOutlierValue(value)) {
    const n = value.outliersFlagged;
    return `${n.toLocaleString()} flagged`;
  }
  return String(value);
}

/**
 * The middle-dot marker substituted for each literal space so leading,
 * trailing, and repeated spaces in whitespace/case diffs stay visible even
 * though the browser would otherwise collapse them (Req 2.1 presentation).
 * Purely a display transform — the underlying proposal value is never changed.
 */
const SPACE_MARKER = "\u00B7"; // ·

/**
 * Render a whitespace/case value so its spaces are visible: each space becomes
 * a middle dot and the surrounding span uses `white-space: pre` (see
 * `.stitch-diff__value--whitespace` in ApprovalScreen.css). The returned string
 * is still a plain text node — only the glyph shown for a space changes, not
 * the stored value.
 */
function makeWhitespaceVisible(display: string): string {
  return display.replace(/ /g, SPACE_MARKER);
}

/**
 * Render a whitespace/case proposal's `reason` sentence so the quoted
 * example values inside it (e.g. `\"swamp  wraith\" \u2192 \"swamp wraith\"`)
 * get the SAME visible-space treatment as the Before/After boxes (item 3).
 * Otherwise the browser collapses the spaces and the two examples look
 * identical.
 *
 * We locate the literal `\"before\"` and `\"after\"` substrings in the reason
 * (quotes included) and render just those occurrences inside a
 * `white-space: pre` span with each space shown as a middle dot. All other
 * parts of the sentence render as ordinary wrapping text. Everything is a
 * React text node, so the plain-text / no-markup guarantee holds (Req 6.8).
 */
function renderWhitespaceReason(
  reason: string,
  before: unknown,
  after: unknown
): JSX.Element {
  // The quoted example tokens to highlight, longest first so a shorter one
  // (e.g. the trimmed `after`) never splits inside the longer `before`.
  const tokens = [before, after]
    .filter((v): v is string => typeof v === "string")
    .map((v) => `"${v}"`)
    .sort((a, b) => b.length - a.length);

  if (tokens.length === 0) {
    return <>{reason}</>;
  }

  // Walk the reason, emitting plain text between token occurrences and a
  // visible-space span for each token occurrence.
  const parts: JSX.Element[] = [];
  let rest = reason;
  let key = 0;
  while (rest.length > 0) {
    // Find the earliest occurrence of any token in the remaining string.
    let bestIdx = -1;
    let bestToken = "";
    for (const token of tokens) {
      const idx = rest.indexOf(token);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestToken = token;
      }
    }
    if (bestIdx === -1) {
      parts.push(<span key={key++}>{rest}</span>);
      break;
    }
    if (bestIdx > 0) {
      parts.push(<span key={key++}>{rest.slice(0, bestIdx)}</span>);
    }
    parts.push(
      <span
        key={key++}
        className="stitch-diff__value--whitespace stitch-proposal__reason-example"
      >
        {makeWhitespaceVisible(bestToken)}
      </span>
    );
    rest = rest.slice(bestIdx + bestToken.length);
  }
  return <>{parts}</>;
}

/** The column/row target label for the proposal (plain text). */
function targetLabel(proposal: CleaningProposal): string {
  const { tableName, columnName } = proposal.target;
  return columnName ? `${tableName}.${columnName}` : tableName;
}

/**
 * A single cleaning proposal rendered as a before/after diff with approve /
 * reject controls, an engine badge, and (for category-standardize) an editable
 * canonical value.
 */
export function CleaningDiff({
  proposal,
  decision,
  onApprove,
  onReject,
  onEditCanonical,
}: CleaningDiffProps): JSX.Element {
  const { id, kind, before, after, reason, canonical } = proposal;
  const isCategory = kind === "category-standardize";
  // Whitespace/case diffs need their spaces made visible (Req 4): render each
  // space as a middle dot inside a `white-space: pre` span so leading/trailing/
  // repeated spaces are not collapsed by the browser.
  const isWhitespace = kind === "whitespace-case";
  const beforeDisplay = formatValue(before);
  const afterDisplay = formatValue(after);
  const beforeText = isWhitespace
    ? makeWhitespaceVisible(beforeDisplay)
    : beforeDisplay;
  const afterText = isWhitespace
    ? makeWhitespaceVisible(afterDisplay)
    : afterDisplay;
  const valueClassName = isWhitespace
    ? "stitch-diff__value stitch-diff__value--whitespace"
    : "stitch-diff__value";

  // Local draft of the canonical value so typing feels immediate; it is
  // committed up to the screen on blur / Enter. Kept in sync if the proposal's
  // canonical changes underneath (e.g. after a recompute).
  const [draftCanonical, setDraftCanonical] = useState(canonical ?? "");
  useEffect(() => {
    setDraftCanonical(canonical ?? "");
  }, [canonical]);

  const inputId = `cleaning-canonical-${id}`;

  function commitCanonical(): void {
    const trimmed = draftCanonical;
    if (isCategory && trimmed !== canonical) {
      onEditCanonical(id, trimmed);
    }
  }

  const decisionClass =
    decision === "approved" || decision === "edited"
      ? " stitch-proposal--approved"
      : decision === "rejected"
        ? " stitch-proposal--rejected"
        : "";

  return (
    <article
      id={`proposal-card-${proposal.id}`}
      tabIndex={-1}
      className={`stitch-proposal stitch-proposal--cleaning${decisionClass}`}
      aria-label={`Cleaning proposal ${KIND_TITLE[kind]} on ${targetLabel(proposal)}`}
    >
      <header className="stitch-proposal__header">
        <h4 className="stitch-proposal__title">{KIND_TITLE[kind]}</h4>
        {/*
          Cleaning proposals are always produced by the deterministic rules
          engine, and only MatchProposals carry a `source` and can be AI-refined
          (design: AiProvider "Refine EXISTING matches only"). So the engine
          badge here is fixed to "rules" (Req 6.8).
        */}
        <EngineBadge source="rules" />
        {decision === "approved" || decision === "edited" ? (
          <span className="stitch-proposal__badge stitch-proposal__badge--approved">
            Approved
          </span>
        ) : null}
        {decision === "rejected" ? (
          <span className="stitch-proposal__badge stitch-proposal__badge--rejected">
            Rejected
          </span>
        ) : null}
        <span className="stitch-proposal__target">{targetLabel(proposal)}</span>
      </header>

      <div className="stitch-diff">
        <div className="stitch-diff__side stitch-diff__side--before">
          <span className="stitch-diff__label">Before</span>
          <span className={valueClassName}>{beforeText}</span>
        </div>
        <span className="stitch-diff__arrow" aria-hidden="true">
          →
        </span>
        <div className="stitch-diff__side stitch-diff__side--after">
          <span className="stitch-diff__label">After</span>
          <span className={valueClassName}>{afterText}</span>
        </div>
      </div>

      {/* reason may come from the AI — rendered as a plain text node (Req 6.8). */}
      <p className="stitch-proposal__reason">
        {isWhitespace ? renderWhitespaceReason(reason, before, after) : reason}
      </p>

      {isCategory ? (
        <div className="stitch-proposal__edit">
          <label className="stitch-proposal__edit-label" htmlFor={inputId}>
            Canonical value
          </label>
          <input
            id={inputId}
            type="text"
            className="stitch-proposal__input"
            value={draftCanonical}
            onChange={(e) => setDraftCanonical(e.target.value)}
            onBlur={commitCanonical}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitCanonical();
              }
            }}
          />
        </div>
      ) : null}

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

export default CleaningDiff;
