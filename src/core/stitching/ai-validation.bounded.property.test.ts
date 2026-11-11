/**
 * Property-based test for the bounded, eligible-only, invalid-input-ignoring AI
 * merge.
 *
 * Feature: frankendata-ai-stitching, Property 12: AI refinement is bounded,
 * eligible-only, and ignores invalid input
 *
 * Validates: Requirements 11.4, 11.5, 10.12, 6.5, 6.6
 *
 * Property 12 statement (design: "AI score bounding", "Response validation
 * steps"): for ANY AI response — arbitrary, including adversarial — the
 * validated/merged result obeys all of:
 *
 *   - **Bounded adjustment.** Every refined match's final confidence equals
 *     `clamp(rule + clamp(ai − rule, −0.2, +0.2), 0, 1)`, so a refined score
 *     never moves more than ±0.2 from its rule score and stays in [0, 1]. An
 *     untouched match keeps its rule confidence exactly.
 *   - **Eligible-only / demote-not-resurrect.** A refinement is applied only to
 *     a match that was sent as a candidate (`ruleConfidence >= 0.5`). The AI
 *     can demote a visible match (possibly hiding it below the display
 *     threshold) but can NEVER resurrect/raise a hidden (<0.5) match into
 *     visibility. Refinements referencing unknown/ineligible ids are ignored.
 *   - **Invalid input ignored.** A non-finite/NaN `aiConfidence` rejects that
 *     refinement; an out-of-range (but finite) `aiConfidence` is still harmlessly
 *     bounded by the ±0.2 clamp per the formula; a non-string `reason` rejects
 *     the refinement; an over-long reason is truncated to ≤200 chars; duplicate
 *     ids → the first occurrence wins; a wholly-invalid/mis-shaped response
 *     leaves the rules result unchanged with `aiUsed = false`.
 *
 * ## Proof strategy
 *
 * The invariants live in the pure `validateAiResponse` merge, so the core
 * property exercises it directly over an arbitrary set of sent candidate
 * matches (all `>= MATCH_DISPLAY_THRESHOLD`, as the controller only ever sends
 * candidates) and an arbitrary, deliberately-adversarial response body: random
 * ids (known, unknown, duplicate), random confidences (in-range, out-of-range,
 * NaN, ±Infinity), random reason lengths (including > 200), and occasional
 * non-string reasons / mis-shaped entries. For every generated `(sent, body)`
 * pair it re-derives the expected merge by the design rules and asserts the
 * actual output matches on confidence (exact bounded formula), reason
 * (truncated), source, and `aiUsed`, plus the structural guarantees (same
 * ids/count, never resurrects a hidden id, duplicate-first-wins).
 *
 * A second property exercises the SAME invariants through the real controller
 * refine step with a {@link FakeAiProvider}, over a mixed candidate set that
 * STRADDLES the 0.5 display threshold (some visible, some hidden). It asserts
 * the demote-not-resurrect guarantee end-to-end: a hidden (<0.5) match is never
 * sent, so no AI response — however favorable — can raise it into the displayed
 * ProposalSet. A non-vacuity guard asserts the generators actually produce both
 * sides of the threshold and that the AI genuinely targets hidden ids.
 *
 * This is a pure-logic property (design: "Testing Strategy"): no DuckDB, no
 * network. Every provider is a {@link FakeAiProvider} (Req 6.7, 10.7).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ColumnSchema, ColumnType, LoadedTable } from "../types";
import {
  MAX_REASON_CHARS,
  boundedConfidence,
  validateAiResponse,
} from "./ai-validation";
import { createFakeAiProvider } from "./ai-provider";
import { createStitchController } from "./stitch-controller";
import { StitchStore } from "./stitch-store";
import type { SampleReader, SampleSourceTable } from "./sample-reader";
import type { StitchApplier } from "./stitch-applier";
import {
  MATCH_DISPLAY_THRESHOLD,
  type AiRefinement,
  type AiResponse,
  type CleaningProposal,
  type MatchProposal,
  type RulesEngine,
  type SampleValue,
  type TableSample,
} from "./types";

/** Property-test iteration count (design: fast-check, >= 100 iterations). */
const NUM_RUNS = 200;

const MAX_AI_ADJUSTMENT = 0.2;

// ── Generators for the direct `validateAiResponse` property ──────────────────

/** A stable candidate id. The controller only sends `>= 0.5` matches, so the */
/** sent-set ids are all eligible by construction. */
const sentId = (n: number): string => `sent-${n}`;

/** Build a sent candidate match (all `>= MATCH_DISPLAY_THRESHOLD`). */
function sentMatch(id: string, confidence: number): MatchProposal {
  return {
    id,
    left: { tableName: "a", columnName: "x", type: "string" },
    right: { tableName: "b", columnName: "y", type: "string" },
    confidence,
    reason: `rules reason for ${id}`,
    source: "rules",
    components: { nameSim: 0.5, typeCompat: 1, valueOverlap: 0.5 },
  };
}

/** 1..6 distinctly-identified sent candidates, each `>= 0.5`. */
const genSent: fc.Arbitrary<MatchProposal[]> = fc
  .integer({ min: 1, max: 6 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, () =>
        // A rule confidence anywhere in the eligible [0.5, 1] band.
        fc.double({ min: MATCH_DISPLAY_THRESHOLD, max: 1, noNaN: true })
      )
    )
  )
  .map((confidences) =>
    confidences.map((c, i) => sentMatch(sentId(i), c))
  );

/**
 * A single (possibly adversarial) refinement entry for the response body. It
 * may target a known sent id OR an unknown id; may carry an in-range,
 * out-of-range, NaN, or ±Infinity confidence; a short or > 200-char reason; and
 * occasionally a non-string reason or a mis-shaped (non-object) entry.
 */
function genRefinementEntry(sentIds: string[]): fc.Arbitrary<unknown> {
  const anyId = fc.oneof(
    fc.constantFrom(...sentIds), // a known, eligible id
    fc.constant("unknown-xyz"), // an unknown/ineligible id (ignored)
    fc.string({ maxLength: 8 }) // arbitrary (almost always unknown)
  );
  const anyConfidence = fc.oneof(
    fc.double({ min: 0, max: 1, noNaN: true }), // in range
    fc.double({ min: -5, max: 5, noNaN: true }), // may be out of range
    fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ) // non-finite → rejected
  );
  const anyReason = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.string({ minLength: 201, maxLength: 400 }), // > 200 → truncated
    fc.constant("x".repeat(1000)) // very long → truncated
  );
  const wellShaped = fc.record({
    id: anyId,
    confidence: anyConfidence,
    reason: anyReason,
  });
  // Deliberately-malformed entries that each VALIDATION step must survive:
  // non-string reason / non-number confidence / non-string id / non-object.
  const badReason = fc.record({
    id: anyId,
    confidence: anyConfidence,
    reason: fc.oneof(fc.integer(), fc.constant(null), fc.boolean()),
  });
  const badConfidence = fc.record({
    id: anyId,
    confidence: fc.oneof(fc.string(), fc.constant(null)),
    reason: anyReason,
  });
  const badId = fc.record({
    id: fc.oneof(fc.integer(), fc.constant(null)),
    confidence: anyConfidence,
    reason: anyReason,
  });
  const notAnObject = fc.oneof(
    fc.constant(null),
    fc.integer(),
    fc.string({ maxLength: 4 })
  );
  return fc.oneof(
    { weight: 6, arbitrary: wellShaped },
    { weight: 1, arbitrary: badReason },
    { weight: 1, arbitrary: badConfidence },
    { weight: 1, arbitrary: badId },
    { weight: 1, arbitrary: notAnObject }
  );
}

/**
 * Re-derive the EXPECTED merge from the design rules, independently of the
 * implementation, so the assertion is a true oracle (not a restatement of the
 * code). Walks the refinements in order, applying step 2 (eligible id), step 3
 * (first-wins), step 4 (finite + bounded), step 5 (reason type + truncate).
 */
function expectedMerge(
  sent: MatchProposal[],
  refinements: readonly unknown[]
): Map<string, { confidence: number; reason: string; source: "ai" }> {
  const sentById = new Map(sent.map((m) => [m.id, m]));
  const applied = new Map<
    string,
    { confidence: number; reason: string; source: "ai" }
  >();
  for (const raw of refinements) {
    if (typeof raw !== "object" || raw === null) {
      continue; // mis-shaped entry skipped (step 1, per-entry)
    }
    const rec = raw as Record<string, unknown>;
    if (typeof rec.id !== "string") {
      continue;
    }
    if (typeof rec.confidence !== "number") {
      continue;
    }
    if (typeof rec.reason !== "string") {
      continue;
    }
    const target = sentById.get(rec.id);
    if (!target) {
      continue; // step 2: unknown/ineligible id ignored
    }
    if (applied.has(rec.id)) {
      continue; // step 3: first occurrence wins
    }
    if (!Number.isFinite(rec.confidence)) {
      continue; // step 4: non-finite rejected
    }
    applied.set(rec.id, {
      confidence: boundedConfidence(target.confidence, rec.confidence),
      reason: rec.reason.slice(0, MAX_REASON_CHARS),
      source: "ai",
    });
  }
  return applied;
}

// ── Property 1: direct validateAiResponse over adversarial bodies ────────────

describe("Property 12: AI merge is bounded, eligible-only, ignores invalid input", () => {
  it("validateAiResponse obeys the bounded/eligible/invalid-input invariants for any response", () => {
    fc.assert(
      fc.property(
        genSent.chain((sent) =>
          fc.record({
            sent: fc.constant(sent),
            refinements: fc.array(
              genRefinementEntry(sent.map((m) => m.id)),
              { maxLength: 12 }
            ),
          })
        ),
        ({ sent, refinements }) => {
          const body = { refinements };
          const { matches, aiUsed } = validateAiResponse(body, sent);
          const expected = expectedMerge(sent, refinements);

          // Scope: exactly the sent matches, same ids, same order, nothing
          // added or removed (step 6).
          expect(matches.map((m) => m.id)).toEqual(sent.map((m) => m.id));

          // aiUsed iff at least one refinement survived every step.
          expect(aiUsed).toBe(expected.size > 0);

          const sentById = new Map(sent.map((m) => [m.id, m]));
          for (const m of matches) {
            const rule = sentById.get(m.id)!;
            const exp = expected.get(m.id);

            // Final confidence stays within [0, 1] always.
            expect(m.confidence).toBeGreaterThanOrEqual(0);
            expect(m.confidence).toBeLessThanOrEqual(1);

            if (exp) {
              // Refined: EXACT bounded formula, truncated reason, source "ai".
              expect(m.confidence).toBeCloseTo(exp.confidence, 10);
              expect(m.reason).toBe(exp.reason);
              expect(m.source).toBe("ai");
              // Bounded adjustment: never more than ±0.2 from the rule score.
              expect(Math.abs(m.confidence - rule.confidence)).toBeLessThanOrEqual(
                MAX_AI_ADJUSTMENT + 1e-9
              );
              // Reason never exceeds the cap.
              expect(m.reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
            } else {
              // Untouched: rule confidence + reason + source preserved exactly.
              expect(m.confidence).toBe(rule.confidence);
              expect(m.reason).toBe(rule.reason);
              expect(m.source).toBe("rules");
            }
          }

          // Input is never mutated.
          for (const m of sent) {
            expect(m.source).toBe("rules");
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("ignores refinements for unknown ids entirely (eligible-only)", () => {
    fc.assert(
      fc.property(
        genSent,
        fc.array(
          fc.record({
            id: fc.string({ minLength: 20, maxLength: 24 }), // never a sent id
            confidence: fc.double({ min: 0, max: 1, noNaN: true }),
            reason: fc.string({ maxLength: 40 }),
          }),
          { minLength: 1, maxLength: 8 }
        ),
        (sent, unknowns) => {
          // Prefix "ext-" guarantees these ids are disjoint from "sent-N".
          const refinements = unknowns.map((r) => ({ ...r, id: `ext-${r.id}` }));
          const { matches, aiUsed } = validateAiResponse({ refinements }, sent);
          expect(aiUsed).toBe(false);
          // Every match keeps its exact rule values — unknown ids changed nothing.
          for (let i = 0; i < sent.length; i++) {
            expect(matches[i].confidence).toBe(sent[i].confidence);
            expect(matches[i].reason).toBe(sent[i].reason);
            expect(matches[i].source).toBe("rules");
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("applies the first refinement for a duplicated id and discards the rest", () => {
    fc.assert(
      fc.property(
        fc.double({ min: MATCH_DISPLAY_THRESHOLD, max: 1, noNaN: true }),
        fc.array(
          fc.record({
            confidence: fc.double({ min: 0, max: 1, noNaN: true }),
            reason: fc.string({ maxLength: 40 }),
          }),
          { minLength: 2, maxLength: 6 }
        ),
        (ruleConf, variants) => {
          const sent = [sentMatch("dup", ruleConf)];
          const refinements = variants.map((v) => ({ id: "dup", ...v }));
          const { matches } = validateAiResponse({ refinements }, sent);
          // First occurrence wins: result equals applying ONLY variants[0].
          const first = variants[0];
          expect(matches[0].confidence).toBeCloseTo(
            boundedConfidence(ruleConf, first.confidence),
            10
          );
          expect(matches[0].reason).toBe(first.reason.slice(0, MAX_REASON_CHARS));
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("leaves the rules result unchanged (aiUsed=false) for a mis-shaped body", () => {
    fc.assert(
      fc.property(
        genSent,
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string({ maxLength: 10 }),
          fc.integer(),
          fc.record({ refinements: fc.string() }), // refinements not an array
          fc.record({ nope: fc.integer() }) // no refinements field
        ),
        (sent, badBody) => {
          const { matches, aiUsed } = validateAiResponse(badBody, sent);
          expect(aiUsed).toBe(false);
          for (let i = 0; i < sent.length; i++) {
            expect(matches[i].confidence).toBe(sent[i].confidence);
            expect(matches[i].reason).toBe(sent[i].reason);
            expect(matches[i].source).toBe("rules");
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("truncates an over-long reason to exactly 200 chars whenever a refinement applies", () => {
    fc.assert(
      fc.property(
        fc.double({ min: MATCH_DISPLAY_THRESHOLD, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.string({ minLength: 201, maxLength: 600 }),
        (ruleConf, aiConf, longReason) => {
          const sent = [sentMatch("m", ruleConf)];
          const { matches, aiUsed } = validateAiResponse(
            { refinements: [{ id: "m", confidence: aiConf, reason: longReason }] },
            sent
          );
          expect(aiUsed).toBe(true);
          expect(matches[0].reason).toHaveLength(MAX_REASON_CHARS);
          expect(matches[0].reason).toBe(longReason.slice(0, MAX_REASON_CHARS));
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

// ── Controller-level demote-not-resurrect (straddling the 0.5 threshold) ─────

const ALL_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/** A StitchApplier that is never invoked by computeProposals. */
const NOOP_APPLIER: StitchApplier = {
  apply: async () => {
    throw new Error("applier.apply must not be called by computeProposals");
  },
  undo: async () => [],
  pendingUndo: () => null,
  nextCounter: () => 1,
};

function fakeSampleReader(result: TableSample[]): SampleReader {
  return {
    readTable: async (t: SampleSourceTable) =>
      result.find((r) => r.tableName === t.tableName) ?? {
        tableName: t.tableName,
        rowCount: t.rowCount,
        schema: t.schema,
        samplesByColumn: {},
      },
    readTables: async () => result,
  };
}

function fakeRulesEngine(matches: MatchProposal[]): RulesEngine {
  return {
    match: () => matches,
    clean: async (): Promise<CleaningProposal[]> => [],
  };
}

/** Two tables, each with the five fixed columns, so any generated match id is */
/** realizable from real column refs. */
function twoTables(): { tables: LoadedTable[]; samples: TableSample[] } {
  const cols = ["c0", "c1", "c2", "c3", "c4"] as const;
  const names = ["left_tbl", "right_tbl"] as const;
  const tables: LoadedTable[] = names.map((name, i) => {
    const schema: ColumnSchema[] = cols.map((c, j) => ({
      name: c,
      type: ALL_TYPES[(i + j) % ALL_TYPES.length],
    }));
    return {
      loadId: i + 1,
      tableName: name,
      sourceFileName: `${name}.csv`,
      schema,
      rowCount: 10,
    };
  });
  const samplesByColumn: Record<string, SampleValue[]> = {};
  for (const c of cols) {
    samplesByColumn[c] = [{ value: "v", count: 5 }];
  }
  const samples: TableSample[] = tables.map((t) => ({
    tableName: t.tableName,
    rowCount: 10,
    schema: t.schema,
    samplesByColumn,
  }));
  return { tables, samples };
}

/** A rules match between left_tbl.cX and right_tbl.cY with a given confidence. */
function ctrlMatch(
  tables: LoadedTable[],
  leftIdx: number,
  rightIdx: number,
  confidence: number
): MatchProposal {
  const [a, b] = tables;
  const leftCol = a.schema[leftIdx];
  const rightCol = b.schema[rightIdx];
  return {
    id: `${a.tableName}.${leftCol.name}|${b.tableName}.${rightCol.name}`,
    left: { tableName: a.tableName, columnName: leftCol.name, type: leftCol.type },
    right: { tableName: b.tableName, columnName: rightCol.name, type: rightCol.type },
    confidence,
    reason: "rules",
    source: "rules",
    components: { nameSim: 0.5, typeCompat: 1, valueOverlap: 0.5 },
  };
}

describe("Property 12 (controller): demote-not-resurrect across the 0.5 threshold", () => {
  it("no AI response raises a hidden (<0.5) match into the displayed set", async () => {
    const { tables, samples } = twoTables();

    // Generate a set of matches straddling the threshold: each match has a
    // left/right column pair (unique) and a rule confidence that is explicitly
    // chosen to be visible (>=0.5) or hidden (<0.5).
    const genMatches = fc
      .uniqueArray(
        fc.record({
          leftIdx: fc.integer({ min: 0, max: 4 }),
          rightIdx: fc.integer({ min: 0, max: 4 }),
          visible: fc.boolean(),
          // A confidence on the correct side of the 0.5 threshold.
          vis: fc.double({ min: MATCH_DISPLAY_THRESHOLD, max: 1, noNaN: true }),
          hid: fc.double({ min: 0, max: 0.4999, noNaN: true }),
        }),
        {
          minLength: 2,
          maxLength: 8,
          selector: (m) => `${m.leftIdx}|${m.rightIdx}`,
        }
      )
      .map((specs) =>
        specs.map((s) =>
          ctrlMatch(
            tables,
            s.leftIdx,
            s.rightIdx,
            s.visible ? s.vis : s.hid
          )
        )
      )
      // Non-vacuity: keep only draws that have BOTH a visible and a hidden
      // match, so demote-not-resurrect is genuinely exercised.
      .filter(
        (ms) =>
          ms.some((m) => m.confidence >= MATCH_DISPLAY_THRESHOLD) &&
          ms.some((m) => m.confidence < MATCH_DISPLAY_THRESHOLD)
      );

    let sawHiddenTargeted = false;

    await fc.assert(
      fc.asyncProperty(genMatches, async (matches) => {
          const hiddenIds = new Set(
            matches
              .filter((m) => m.confidence < MATCH_DISPLAY_THRESHOLD)
              .map((m) => m.id)
          );
          sawHiddenTargeted ||= hiddenIds.size > 0;

          // An adversarial AI that returns a max-boost refinement for EVERY
          // match id — including the hidden ones it should never have seen.
          const refinements: AiRefinement[] = matches.map((m) => ({
            id: m.id,
            confidence: 1,
            reason: `boost ${m.id}`,
          }));
          const response: AiResponse = { refinements };

          const store = new StitchStore();
          const controller = createStitchController({
            db: {} as never,
            getTables: () => tables,
            store,
            sampleReader: fakeSampleReader(samples),
            rulesEngine: fakeRulesEngine(matches),
            applier: NOOP_APPLIER,
            aiProvider: createFakeAiProvider({
              behavior: { kind: "respond", response },
            }),
            aiEnabledFlag: "true",
          });

          const result = await controller.computeProposals();
          const displayedIds = new Set(result.matches.map((m) => m.id));

          // Demote-not-resurrect: NO hidden (<0.5) match may appear displayed,
          // no matter how favorable the AI response.
          for (const hiddenId of hiddenIds) {
            expect(displayedIds.has(hiddenId)).toBe(false);
          }

          // Every displayed match is at or above the display threshold.
          for (const m of result.matches) {
            expect(m.confidence).toBeGreaterThanOrEqual(MATCH_DISPLAY_THRESHOLD);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );

    // Non-vacuity guard: the generator actually produced hidden matches for the
    // AI to (fail to) resurrect.
    expect(sawHiddenTargeted).toBe(true);
  });
});
