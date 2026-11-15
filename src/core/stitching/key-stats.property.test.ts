/**
 * Feature: frankendata-join-key, Property 1: the default join key is never less
 * key-like than an available alternative of similar confidence.
 *
 * For any set of candidate matches between two tables, with any side distinct
 * ratios and any confidences, the chosen default has a key ratio (the ratio of
 * its more distinct side) at least as high as every other candidate whose
 * confidence is within 0.1 of the chosen one's. The choice does not depend on
 * the order of the candidates.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { chooseDefaultMatch, keyRatio, statsKey } from "./key-stats";
import type { ColumnKeyStats, MatchProposal } from "./types";

interface Spec {
  confidence: number;
  left: number;
  right: number;
}

const ratio = fc.oneof(
  fc.constant(1),
  fc.double({ min: 0.01, max: 1, noNaN: true }).map((x) => Math.round(x * 100) / 100)
);
const spec = fc.record({
  confidence: fc.integer({ min: 50, max: 100 }).map((n) => n / 100),
  left: ratio,
  right: ratio,
});

function build(specs: Spec[]): { matches: MatchProposal[]; stats: Record<string, ColumnKeyStats> } {
  const stats: Record<string, ColumnKeyStats> = {};
  const matches = specs.map((s, i): MatchProposal => {
    const lc = `l${i}`;
    const rc = `r${i}`;
    stats[statsKey("a", lc)] = { nonNull: 100, distinct: Math.round(s.left * 100), distinctRatio: s.left };
    stats[statsKey("b", rc)] = { nonNull: 100, distinct: Math.round(s.right * 100), distinctRatio: s.right };
    return {
      id: `match:a.${lc}=b.${rc}`,
      left: { tableName: "a", columnName: lc, type: "string" },
      right: { tableName: "b", columnName: rc, type: "string" },
      confidence: s.confidence,
      reason: "",
      source: "rules",
      components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
    };
  });
  return { matches, stats };
}

describe("Feature: frankendata-join-key, Property 1: default key is key-like", () => {
  it("never has a lower key ratio than an alternative within 0.1 confidence", () => {
    fc.assert(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 8 }), (specs) => {
        const { matches, stats } = build(specs);
        const chosen = chooseDefaultMatch(matches, stats)!;
        expect(chosen).toBeDefined();
        const chosenRatio = keyRatio(chosen, stats);
        for (const alt of matches) {
          if (Math.abs(alt.confidence - chosen.confidence) <= 0.1 + 1e-9) {
            expect(chosenRatio).toBeGreaterThanOrEqual(keyRatio(alt, stats) - 1e-12);
          }
        }
      }),
      { numRuns: 500 }
    );
  });

  it("does not depend on the order of the candidates", () => {
    fc.assert(
      fc.property(fc.array(spec, { minLength: 2, maxLength: 8 }), fc.nat(), (specs, shift) => {
        const { matches, stats } = build(specs);
        const k = shift % matches.length;
        const rotated = [...matches.slice(k), ...matches.slice(0, k)];
        expect(chooseDefaultMatch(rotated, stats)?.id).toBe(chooseDefaultMatch(matches, stats)?.id);
        expect(chooseDefaultMatch([...matches].reverse(), stats)?.id).toBe(
          chooseDefaultMatch(matches, stats)?.id
        );
      }),
      { numRuns: 300 }
    );
  });

  it("is the highest-confidence match when every column is equally key-like", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 50, max: 100 }), { minLength: 1, maxLength: 8 }), ratio, (confs, r) => {
        const { matches, stats } = build(confs.map((c) => ({ confidence: c / 100, left: r, right: r })));
        const chosen = chooseDefaultMatch(matches, stats)!;
        const top = Math.max(...matches.map((m) => m.confidence));
        expect(chosen.confidence).toBe(top);
      }),
      { numRuns: 300 }
    );
  });

  it("falls back to confidence alone without stats", () => {
    fc.assert(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 8 }), (specs) => {
        const { matches } = build(specs);
        const chosen = chooseDefaultMatch(matches, undefined)!;
        expect(chosen.confidence).toBe(Math.max(...matches.map((m) => m.confidence)));
      }),
      { numRuns: 200 }
    );
  });
});
