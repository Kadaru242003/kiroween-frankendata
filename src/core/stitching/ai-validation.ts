/**
 * AI response validation and bounded merge (Feature 2, task 19; design:
 * "AI score bounding" + "Response validation steps").
 *
 * {@link validateAiResponse} is a pure function applied to any proxy `200` body
 * before it can influence output. It takes the raw (untrusted) body and the
 * rules-engine matches that were sent as candidates, and returns the matches
 * with the surviving, bounded refinements merged in. It never throws: an
 * unparseable/mis-shaped body yields the rules matches unchanged (the caller
 * then reports `aiUsed = false`); a partially-valid body merges the valid
 * refinements and leaves the rest on their rules values.
 *
 * Validation steps (design, in order):
 *   1. Shape — body must be `{ refinements: AiRefinement[] }` with each entry an
 *      object carrying a string `id`, a numeric `confidence`, and a string
 *      `reason`. A mis-shaped body is a total failure → rules unchanged.
 *   2. Known & eligible ids only — a refinement whose `id` is not one of the
 *      sent candidate ids is dropped (blocks unknown columns AND resurrection
 *      of hidden, below-threshold matches; the controller only ever sends
 *      candidates `>= MATCH_DISPLAY_THRESHOLD`).
 *   3. Duplicate ids — the FIRST refinement for an id wins; later ones for the
 *      same id are discarded (deterministic).
 *   4. Score range + bounding — a non-finite/NaN `confidence` rejects that
 *      refinement; otherwise the final score is
 *      `clamp(rule + clamp(ai − rule, −0.2, +0.2), 0, 1)` so the AI may move a
 *      score by at most ±0.2 and the result stays in [0, 1].
 *   5. Reason length — truncated to at most {@link MAX_REASON_CHARS} (200); a
 *      non-string reason rejects the refinement.
 *   6. Scope — only `confidence` and `reason` of an existing, eligible match
 *      change; nothing is added, removed, or approved.
 *   7. Markup safety — the (truncated) reason is stored as-is; the UI always
 *      renders it as plain text, never HTML/markdown (enforced at the render
 *      layer; this function performs no markup interpretation).
 *
 * A surviving refinement sets its match's `source = "ai"`; untouched matches
 * keep `source = "rules"`. Pure, framework-agnostic, deterministic.
 */

import { MATCH_DISPLAY_THRESHOLD } from "./types";
import type { MatchProposal } from "./types";

/** Max characters kept from an AI `reason` (design: "Reason length"). */
export const MAX_REASON_CHARS = 200;

/** Max absolute adjustment the AI may apply to a rule score (design). */
export const MAX_AI_ADJUSTMENT = 0.2;

/**
 * Max POSITIVE lift the AI may apply to a DISCOVERED candidate — one whose
 * rule score was below {@link MATCH_DISPLAY_THRESHOLD} (enhancement:
 * two-tier bounded lift). For discovered candidates the adjustment is
 * clamped to `[0, +0.3]` (never negative), so the AI can only PROMOTE a
 * sub-threshold match, by at most +0.3. Since the starting rule score is
 * < 0.5, the final can never reach HIGH_CONFIDENCE_THRESHOLD (0.85), so a
 * discovered match is never auto-approved by "Approve all high-confidence".
 */
export const MAX_AI_DISCOVERY_LIFT = 0.3;

/** Clamp a number to the inclusive range `[lo, hi]`. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) {
    return lo;
  }
  if (value > hi) {
    return hi;
  }
  return value;
}

/**
 * The bounded AI adjustment (design: "AI score bounding"). The AI can only
 * *nudge* a rule score by at most ±{@link MAX_AI_ADJUSTMENT}, and the result is
 * clamped to [0, 1]. An out-of-range `aiConfidence` can therefore still only
 * shift the final score by the bounded amount.
 *
 *   final = clamp(rule + clamp(ai − rule, −0.2, +0.2), 0, 1)
 */
export function boundedConfidence(
  ruleConfidence: number,
  aiConfidence: number
): number {
  const delta = clamp(
    aiConfidence - ruleConfidence,
    -MAX_AI_ADJUSTMENT,
    MAX_AI_ADJUSTMENT
  );
  return clamp(ruleConfidence + delta, 0, 1);
}

/**
 * The POSITIVE-only bounded lift for a DISCOVERED candidate (rule score
 * below {@link MATCH_DISPLAY_THRESHOLD}): the adjustment is clamped to
 * `[0, +MAX_AI_DISCOVERY_LIFT]` so the AI can only promote (never demote) a
 * sub-threshold match, and the result is clamped to [0, 1].
 *
 *   final = clamp(rule + clamp(ai − rule, 0, +0.3), 0, 1)
 */
export function discoveredConfidence(
  ruleConfidence: number,
  aiConfidence: number
): number {
  const delta = clamp(aiConfidence - ruleConfidence, 0, MAX_AI_DISCOVERY_LIFT);
  return clamp(ruleConfidence + delta, 0, 1);
}

/** A structurally-valid refinement after step 1 (shape) passes. */
interface ValidRefinement {
  id: string;
  confidence: number;
  reason: string;
}

/**
 * Step 1 (shape). Parse the untrusted body into a list of structurally-valid
 * refinements, or `null` if the overall shape is wrong (a total failure). Each
 * entry must be an object with a string `id`, a numeric `confidence` (any
 * number here; finiteness is checked in step 4), and a string `reason`. An
 * individual entry that is not an object or is missing/mistyped fields is NOT a
 * total failure — it is simply skipped — so a single bad entry cannot discard
 * valid siblings. Only a non-object body or a non-array `refinements` is a
 * total failure.
 */
function parseShape(body: unknown): ValidRefinement[] | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const refinements = (body as { refinements?: unknown }).refinements;
  if (!Array.isArray(refinements)) {
    return null;
  }
  const out: ValidRefinement[] = [];
  for (const entry of refinements) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== "string") {
      continue;
    }
    if (typeof rec.confidence !== "number") {
      continue;
    }
    if (typeof rec.reason !== "string") {
      continue;
    }
    out.push({
      id: rec.id,
      confidence: rec.confidence,
      reason: rec.reason,
    });
  }
  return out;
}

/**
 * Validate and merge an AI response body into the sent candidate matches.
 *
 * @param body    the untrusted proxy `200` body (already JSON-parsed).
 * @param sent    the matches that were sent as candidates. These define the
 *                eligible id set (step 2); every one is already
 *                `>= MATCH_DISPLAY_THRESHOLD`. They are returned (clones)
 *                regardless of whether they were refined.
 * @returns `{ matches, aiUsed }`. `matches` is `sent` with valid refinements
 *          merged (confidence via the bounded formula, truncated reason,
 *          `source = "ai"`); unrefined matches are unchanged (`source` kept).
 *          `aiUsed` is `true` iff at least one refinement survived validation
 *          AND the body shape was valid; a total-shape failure yields the sent
 *          matches unchanged with `aiUsed = false`.
 */
export function validateAiResponse(
  body: unknown,
  sent: readonly MatchProposal[]
): { matches: MatchProposal[]; aiUsed: boolean } {
  // Clone the sent matches so the input is never mutated; keep a lookup by id.
  const byId = new Map<string, MatchProposal>();
  const matches: MatchProposal[] = sent.map((m) => {
    const clone: MatchProposal = { ...m, components: { ...m.components } };
    byId.set(clone.id, clone);
    return clone;
  });

  // Step 1: shape. A total failure leaves the rules matches unchanged.
  const parsed = parseShape(body);
  if (parsed === null) {
    return { matches, aiUsed: false };
  }

  const appliedIds = new Set<string>();
  let anyApplied = false;

  for (const refinement of parsed) {
    // Step 2: known & eligible id only. Unknown/ineligible ids are dropped.
    const target = byId.get(refinement.id);
    if (!target) {
      continue;
    }
    // Step 3: duplicate id — first occurrence wins.
    if (appliedIds.has(refinement.id)) {
      continue;
    }
    // Step 4: non-finite/NaN confidence rejects this refinement.
    if (!Number.isFinite(refinement.confidence)) {
      continue;
    }
    // The tier is decided by the SENT candidate's rule score. Tier 1
    // (rule >= 0.5): the existing symmetric ±0.2 nudge. Tier 2 (rule < 0.5,
    // AI-DISCOVERED): a positive-only lift of at most +0.3, and ONLY when the
    // refinement carries a non-empty reason (a discovered match with no
    // justification is treated as invalid for that candidate → keep the rule
    // score, do not mark it ai).
    const ruleConfidence = target.confidence;
    const isDiscovered = ruleConfidence < MATCH_DISPLAY_THRESHOLD;
    const trimmedReason = refinement.reason.trim();
    if (isDiscovered && trimmedReason.length === 0) {
      // Invalid discovery (no evidence) — leave the rule score untouched.
      continue;
    }
    const finalConfidence = isDiscovered
      ? discoveredConfidence(ruleConfidence, refinement.confidence)
      : boundedConfidence(ruleConfidence, refinement.confidence);
    target.confidence = finalConfidence;
    // Step 5: truncate the reason to the cap; step 6/7: scope + stored as-is.
    target.reason = refinement.reason.slice(0, MAX_REASON_CHARS);
    // Step 6: only confidence + reason change; mark the engine as AI (Req 6.8).
    target.source = "ai";
    // Flag a genuine discovery: a sub-threshold rule score lifted to visible.
    if (isDiscovered && finalConfidence >= MATCH_DISPLAY_THRESHOLD) {
      target.aiDiscovered = true;
    }

    appliedIds.add(refinement.id);
    anyApplied = true;
  }

  return { matches, aiUsed: anyApplied };
}
