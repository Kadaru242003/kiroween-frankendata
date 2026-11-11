/**
 * EngineBadge — a per-proposal badge showing which engine produced (or last
 * touched) a proposal: the deterministic rules engine or the optional AI
 * refinement (Feature 2, task 13; design "per-proposal engine badge (rules vs
 * AI)", Req 6.8).
 *
 * The label text is a fixed, in-code string keyed off the proposal's
 * {@link ProposalSource} — never user- or AI-supplied — so there is nothing to
 * escape here, but it is still rendered as a plain React text node.
 */

import { type JSX } from "react";
import type { ProposalSource } from "../../core/stitching/types";

/** Props for {@link EngineBadge}. */
export interface EngineBadgeProps {
  /** Which engine produced/last-touched the proposal (Req 6.8). */
  source: ProposalSource;
}

/** The visible label for each source. */
const SOURCE_LABEL: Record<ProposalSource, string> = {
  rules: "rules",
  ai: "ai",
};

/**
 * A small badge reading `rules` or `ai` for the proposal's `source` (Req 6.8).
 */
export function EngineBadge({ source }: EngineBadgeProps): JSX.Element {
  return (
    <span
      className={`stitch-engine-badge stitch-engine-badge--${source}`}
      data-source={source}
      aria-label={`Produced by ${SOURCE_LABEL[source]} engine`}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

export default EngineBadge;
