/**
 * Property-based tests for the "approve all high-confidence" selection.
 *
 * Feature: frankendata-ai-stitching, Property 10: Approve-all-high-confidence
 * selects exactly the ≥ threshold set.
 *
 * Validates: Requirements 3.3, 10.10
 *
 * Property 10 statement (design, "Correctness Properties"): *For any*
 * `ProposalSet`, "approve all high-confidence" approves exactly the proposals
 * whose `ConfidenceScore` is at or above `HIGH_CONFIDENCE_THRESHOLD`, and no
 * others.
 *
 * The bulk-approve action in the {@link
 * import("../../components/stitching/ApprovalScreen").ApprovalScreen} is driven
 * by the pure {@link selectHighConfidenceProposalIds} helper (Req 3.3): it
 * returns the ids of exactly the proposals at or above
 * {@link HIGH_CONFIDENCE_THRESHOLD}. Testing the pure selection proves the
 * property without rendering React — the component calls the same helper, so
 * the UI behavior and the tested logic are one and the same.
 *
 * The invariant is proved in both directions over arbitrary proposal sets whose
 * confidences straddle the threshold:
 *   (a) every selected id belongs to a proposal with `confidence >= threshold`
 *       (nothing below the threshold is approved); and
 *   (b) every proposal with `confidence >= threshold` is selected (nothing at or
 *       above the threshold is dropped) — i.e. the selected set equals the
 *       `>= threshold` subset exactly, as sets.
 *
 * The boundary (`confidence === threshold`) is exercised directly: the generator
 * mixes values strictly below, exactly at, and strictly above the threshold, and
 * a non-vacuity guard requires that across the run both subsets are non-empty.
 *
 * This is a pure-logic property: no DuckDB, no network, no React render.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { selectHighConfidenceProposalIds } from "./plan-assembly";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  type MatchProposal,
} from "./types";

/** Property-test iteration count (design: fast-check, >= 100 iterations). */
const NUM_RUNS = 200;

const T = HIGH_CONFIDENCE_THRESHOLD; // 0.85

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * A confidence in `[0, 1]` deliberately drawn so the sample straddles the
 * threshold: strictly-below, exactly-at, and strictly-above bands are each
 * reachable, with the exact boundary value {@link HIGH_CONFIDENCE_THRESHOLD}
 * guaranteed to appear often. This is what makes the `>=` boundary genuinely
 * exercised rather than vacuously skipped.
 */
const confidence: fc.Arbitrary<number> = fc.oneof(
  // strictly below the threshold
  fc.double({ min: 0, max: T, noNaN: true, maxExcluded: true }),
  // exactly at the threshold (the inclusive boundary — must be selected)
  fc.constant(T),
  // at or above the threshold
  fc.double({ min: T, max: 1, noNaN: true }),
);

/**
 * A single match proposal with a unique id and a straddling confidence. Only
 * `id` and `confidence` drive the selection, but we build a full
 * {@link MatchProposal} so the helper is exercised against the real shape it
 * sees from the store.
 */
function genProposal(index: number): fc.Arbitrary<MatchProposal> {
  return confidence.map((c) => ({
    id: `p${index}`,
    left: { tableName: "a", columnName: `l${index}`, type: "string" as const },
    right: { tableName: "b", columnName: `r${index}`, type: "string" as const },
    confidence: c,
    reason: "generated",
    source: "rules" as const,
    components: { nameSim: 0, typeCompat: 0, valueOverlap: 0 },
  }));
}

/**
 * A proposal set (0..12 proposals) with DISTINCT ids, each confidence
 * straddling the threshold. Distinct ids keep the "as sets" comparison clean.
 */
const proposalSet: fc.Arbitrary<MatchProposal[]> = fc
  .nat({ max: 12 })
  .chain((count) =>
    fc.tuple(...Array.from({ length: count }, (_, i) => genProposal(i))),
  )
  .map((arr) => [...arr]);

/** The set of ids whose confidence is `>= threshold` (the expected selection). */
function expectedSelectedIds(
  proposals: readonly MatchProposal[],
  threshold: number,
): Set<string> {
  return new Set(
    proposals.filter((p) => p.confidence >= threshold).map((p) => p.id),
  );
}

// ── The headline property: selected set === the >= threshold subset ────────────

describe("Property 10: Approve-all-high-confidence selects exactly the >= threshold set", () => {
  it("(a) every selected id has confidence >= HIGH_CONFIDENCE_THRESHOLD (nothing below is approved)", () => {
    fc.assert(
      fc.property(proposalSet, (proposals) => {
        const selected = new Set(selectHighConfidenceProposalIds(proposals, T));
        const byId = new Map(proposals.map((p) => [p.id, p] as const));
        for (const id of selected) {
          const proposal = byId.get(id);
          expect(proposal).toBeDefined();
          expect(proposal?.confidence).toBeGreaterThanOrEqual(T);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(b) every proposal with confidence >= threshold is selected (nothing at/above is dropped)", () => {
    fc.assert(
      fc.property(proposalSet, (proposals) => {
        const selected = new Set(selectHighConfidenceProposalIds(proposals, T));
        for (const proposal of proposals) {
          if (proposal.confidence >= T) {
            expect(
              selected.has(proposal.id),
              `>= threshold proposal ${proposal.id} (conf=${proposal.confidence}) must be approved`,
            ).toBe(true);
          } else {
            expect(
              selected.has(proposal.id),
              `below-threshold proposal ${proposal.id} (conf=${proposal.confidence}) must NOT be approved`,
            ).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("the selected set equals the >= threshold subset exactly (nothing added, nothing dropped)", () => {
    fc.assert(
      fc.property(proposalSet, (proposals) => {
        const actual = selectHighConfidenceProposalIds(proposals, T);
        const expected = expectedSelectedIds(proposals, T);

        // No duplicates, and exactly the expected membership.
        expect(new Set(actual).size).toBe(actual.length);
        expect(new Set(actual)).toEqual(expected);
        expect(actual.length).toBe(expected.size);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("the default threshold is HIGH_CONFIDENCE_THRESHOLD (what the UI uses)", () => {
    fc.assert(
      fc.property(proposalSet, (proposals) => {
        // Calling without an explicit threshold must behave identically to
        // passing HIGH_CONFIDENCE_THRESHOLD, since that is the UI's constant.
        expect(selectHighConfidenceProposalIds(proposals)).toEqual(
          selectHighConfidenceProposalIds(proposals, T),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ── Boundary check: a proposal exactly at the threshold is selected ────────────

describe("Property 10: the inclusive >= boundary is respected", () => {
  it("a proposal with confidence exactly at the threshold is approved", () => {
    const atBoundary: MatchProposal = {
      id: "boundary",
      left: { tableName: "a", columnName: "l", type: "string" },
      right: { tableName: "b", columnName: "r", type: "string" },
      confidence: T,
      reason: "at the boundary",
      source: "rules",
      components: { nameSim: 0, typeCompat: 0, valueOverlap: 0 },
    };
    expect(selectHighConfidenceProposalIds([atBoundary], T)).toEqual([
      "boundary",
    ]);
  });
});

// ── Non-vacuity guard: the threshold is actually exercised ─────────────────────
//
// The "exactly the >= subset" property is vacuously satisfied if generated
// inputs never produce proposals on BOTH sides of the threshold. Across the
// whole run we require seeing at least one proposal strictly below the
// threshold AND at least one at/above it AND at least one exactly at the
// boundary — so the `>=` boundary is genuinely tested, not skipped.

describe("Property 10: the threshold is actually exercised (non-vacuity)", () => {
  it("across many inputs, proposals fall below, at, and above the threshold", () => {
    let sawBelow = false;
    let sawAtOrAbove = false;
    let sawExactBoundary = false;

    fc.assert(
      fc.property(proposalSet, (proposals) => {
        for (const p of proposals) {
          if (p.confidence < T) {
            sawBelow = true;
          } else {
            sawAtOrAbove = true;
          }
          if (p.confidence === T) {
            sawExactBoundary = true;
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );

    expect(
      sawBelow,
      "generators should produce some below-threshold proposals so the selection is non-vacuous",
    ).toBe(true);
    expect(
      sawAtOrAbove,
      "generators should produce some at/above-threshold proposals so the selection is non-vacuous",
    ).toBe(true);
    expect(
      sawExactBoundary,
      "generators should hit the exact threshold so the inclusive boundary is exercised",
    ).toBe(true);
  });
});
