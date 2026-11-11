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
 * Render an arbitrary representative `before`/`after` value as a plain string.
 * The engine stores these as `unknown`; we stringify defensively so the output
 * is always a plain text node (never markup).
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
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

  return (
    <article
      className="stitch-proposal stitch-proposal--cleaning"
      aria-label={`Cleaning proposal ${KIND_TITLE[kind]} on ${targetLabel(proposal)}`}
    >
      <header className="stitch-proposal__header">
        <h4 className="stitch-proposal__title">{KIND_TITLE[kind]}</h4>
        {/*
          Cleaning proposals are always produced by the deterministic rules
          engine — only MatchProposals carry a `source` and can be AI-refined
          (design: AiProvider "Refine EXISTING matches only"). So the engine
          badge here is fixed to "rules" (Req 6.8).
        */}
        <EngineBadge source="rules" />
        <span className="stitch-proposal__target">{targetLabel(proposal)}</span>
      </header>

      <div className="stitch-diff">
        <div className="stitch-diff__side stitch-diff__side--before">
          <span className="stitch-diff__label">Before</span>
          <span className="stitch-diff__value">{formatValue(before)}</span>
        </div>
        <span className="stitch-diff__arrow" aria-hidden="true">
          →
        </span>
        <div className="stitch-diff__side stitch-diff__side--after">
          <span className="stitch-diff__label">After</span>
          <span className="stitch-diff__value">{formatValue(after)}</span>
        </div>
      </div>

      {/* reason may come from the AI — rendered as a plain text node (Req 6.8). */}
      <p className="stitch-proposal__reason">{reason}</p>

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
