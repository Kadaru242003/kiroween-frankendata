/**
 * Unit tests for AI response validation + bounded merge (Feature 2, task 19;
 * design: "AI score bounding", "Response validation steps").
 *
 * Covers each validation step:
 *   1. shape (total failure → rules unchanged);
 *   2. known & eligible ids only (unknown id dropped);
 *   3. duplicate ids (first wins);
 *   4. bounded ±0.2 adjustment, clamp to [0,1], non-finite rejected;
 *   5. reason truncated to 200 chars, non-string rejected;
 *   6. scope (only confidence + reason change, source → "ai").
 */

import { describe, expect, it } from "vitest";
import {
  MAX_REASON_CHARS,
  boundedConfidence,
  validateAiResponse,
} from "./ai-validation";
import type { MatchProposal } from "./types";

function sentMatch(id: string, confidence: number): MatchProposal {
  return {
    id,
    left: { tableName: "a", columnName: "x", type: "string" },
    right: { tableName: "b", columnName: "y", type: "string" },
    confidence,
    reason: "rules reason",
    source: "rules",
    components: { nameSim: 0.5, typeCompat: 1, valueOverlap: 0.5 },
  };
}

describe("boundedConfidence", () => {
  it("nudges upward by at most +0.2", () => {
    expect(boundedConfidence(0.5, 1)).toBeCloseTo(0.7, 10);
  });

  it("nudges downward by at most -0.2", () => {
    expect(boundedConfidence(0.5, 0)).toBeCloseTo(0.3, 10);
  });

  it("applies small adjustments exactly", () => {
    expect(boundedConfidence(0.6, 0.65)).toBeCloseTo(0.65, 10);
  });

  it("clamps the final result into [0, 1]", () => {
    expect(boundedConfidence(0.95, 2)).toBeLessThanOrEqual(1);
    expect(boundedConfidence(0.1, -5)).toBeGreaterThanOrEqual(0);
  });
});

describe("validateAiResponse — shape (step 1)", () => {
  const sent = [sentMatch("m1", 0.7)];

  it("returns rules unchanged for a non-object body", () => {
    const { matches, aiUsed } = validateAiResponse(null, sent);
    expect(aiUsed).toBe(false);
    expect(matches[0].confidence).toBe(0.7);
    expect(matches[0].source).toBe("rules");
  });

  it("returns rules unchanged when refinements is not an array", () => {
    const { matches, aiUsed } = validateAiResponse(
      { refinements: "nope" },
      sent
    );
    expect(aiUsed).toBe(false);
    expect(matches[0].source).toBe("rules");
  });

  it("does not mutate the input matches", () => {
    validateAiResponse(
      { refinements: [{ id: "m1", confidence: 1, reason: "x" }] },
      sent
    );
    expect(sent[0].confidence).toBe(0.7);
    expect(sent[0].source).toBe("rules");
  });
});

describe("validateAiResponse — eligibility (step 2)", () => {
  it("drops a refinement whose id was not sent", () => {
    const sent = [sentMatch("m1", 0.7)];
    const { matches, aiUsed } = validateAiResponse(
      { refinements: [{ id: "UNKNOWN", confidence: 1, reason: "x" }] },
      sent
    );
    expect(aiUsed).toBe(false);
    expect(matches[0].confidence).toBe(0.7);
  });

  it("applies a refinement for a known/eligible id", () => {
    const sent = [sentMatch("m1", 0.7)];
    const { matches, aiUsed } = validateAiResponse(
      { refinements: [{ id: "m1", confidence: 0.75, reason: "better" }] },
      sent
    );
    expect(aiUsed).toBe(true);
    expect(matches[0].confidence).toBeCloseTo(0.75, 10);
    expect(matches[0].reason).toBe("better");
    expect(matches[0].source).toBe("ai");
  });
});

describe("validateAiResponse — duplicate ids (step 3)", () => {
  it("applies the first refinement for an id and discards the rest", () => {
    const sent = [sentMatch("m1", 0.5)];
    const { matches } = validateAiResponse(
      {
        refinements: [
          { id: "m1", confidence: 0.6, reason: "first" },
          { id: "m1", confidence: 0.9, reason: "second" },
        ],
      },
      sent
    );
    expect(matches[0].reason).toBe("first");
    expect(matches[0].confidence).toBeCloseTo(0.6, 10);
  });
});

describe("validateAiResponse — score bounding (step 4)", () => {
  it("bounds the adjustment to +/-0.2 even for an out-of-range score", () => {
    const sent = [sentMatch("m1", 0.5)];
    const { matches } = validateAiResponse(
      { refinements: [{ id: "m1", confidence: 999, reason: "x" }] },
      sent
    );
    expect(matches[0].confidence).toBeCloseTo(0.7, 10);
  });

  it("rejects a NaN confidence (refinement dropped)", () => {
    const sent = [sentMatch("m1", 0.7)];
    const { matches, aiUsed } = validateAiResponse(
      { refinements: [{ id: "m1", confidence: Number.NaN, reason: "x" }] },
      sent
    );
    expect(aiUsed).toBe(false);
    expect(matches[0].confidence).toBe(0.7);
    expect(matches[0].source).toBe("rules");
  });

  it("rejects an Infinity confidence (refinement dropped)", () => {
    const sent = [sentMatch("m1", 0.7)];
    const { matches, aiUsed } = validateAiResponse(
      {
        refinements: [
          { id: "m1", confidence: Number.POSITIVE_INFINITY, reason: "x" },
        ],
      },
      sent
    );
    expect(aiUsed).toBe(false);
    expect(matches[0].confidence).toBe(0.7);
  });
});

describe("validateAiResponse — reason (step 5)", () => {
  it("truncates the reason to MAX_REASON_CHARS", () => {
    const sent = [sentMatch("m1", 0.7)];
    const longReason = "a".repeat(500);
    const { matches } = validateAiResponse(
      { refinements: [{ id: "m1", confidence: 0.7, reason: longReason }] },
      sent
    );
    expect(matches[0].reason).toHaveLength(MAX_REASON_CHARS);
  });

  it("rejects a non-string reason (refinement dropped)", () => {
    const sent = [sentMatch("m1", 0.7)];
    const { matches, aiUsed } = validateAiResponse(
      { refinements: [{ id: "m1", confidence: 0.8, reason: 123 }] },
      sent
    );
    expect(aiUsed).toBe(false);
    expect(matches[0].confidence).toBe(0.7);
    expect(matches[0].reason).toBe("rules reason");
  });

  it("stores markup-like reason text verbatim (plain-text handled at render)", () => {
    const sent = [sentMatch("m1", 0.7)];
    const markup = "<b>bold</b> & **md**";
    const { matches } = validateAiResponse(
      { refinements: [{ id: "m1", confidence: 0.7, reason: markup }] },
      sent
    );
    expect(matches[0].reason).toBe(markup);
  });
});

describe("validateAiResponse — partial validity + scope (step 6)", () => {
  it("applies valid refinements and leaves invalid ones on rules values", () => {
    const sent = [sentMatch("m1", 0.7), sentMatch("m2", 0.6)];
    const { matches, aiUsed } = validateAiResponse(
      {
        refinements: [
          { id: "m1", confidence: 0.8, reason: "ok" },
          { id: "m2", confidence: Number.NaN, reason: "bad" },
        ],
      },
      sent
    );
    expect(aiUsed).toBe(true);
    const m1 = matches.find((m) => m.id === "m1")!;
    const m2 = matches.find((m) => m.id === "m2")!;
    expect(m1.source).toBe("ai");
    expect(m1.confidence).toBeCloseTo(0.8, 10);
    expect(m2.source).toBe("rules");
    expect(m2.confidence).toBe(0.6);
  });

  it("does not add or remove matches (scope)", () => {
    const sent = [sentMatch("m1", 0.7)];
    const { matches } = validateAiResponse(
      {
        refinements: [
          { id: "m1", confidence: 0.7, reason: "x" },
          { id: "extra", confidence: 0.9, reason: "y" },
        ],
      },
      sent
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("m1");
  });
});
