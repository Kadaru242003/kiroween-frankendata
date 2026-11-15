/**
 * Feature: frankendata-little-frank, Property 2: every reaction is short and its
 * bubble text has no em dash.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FRANK_REACTION_MAX_MS } from "./constants";
import { reactionFor, type FrankEvent } from "./reactions";

const simple = [
  "wake", "stitch-open", "approve", "approve-all", "reject", "confirm-stitch", "stitch-applied",
  "undo-stitch", "fan-out", "autopsy-fix-all", "save-recipe", "apply-recipe", "ask-error", "export", "ai-off", "reset",
] as const;

const event: fc.Arbitrary<FrankEvent> = fc.oneof(
  fc.constantFrom(...simple).map((type) => ({ type }) as FrankEvent),
  fc.integer({ min: -5, max: 500 }).map((tableCount) => ({ type: "files-loaded", tableCount }) as FrankEvent),
  fc.integer({ min: -50, max: 150 }).map((score) => ({ type: "autopsy", score }) as FrankEvent),
  fc.integer({ min: 0, max: 40 }).map((count) => ({ type: "poke", count }) as FrankEvent)
);

describe("Feature: frankendata-little-frank, Property 2: reaction bounds", () => {
  it("lasts at most the limit and says nothing with an em dash", () => {
    fc.assert(
      fc.property(event, (e) => {
        const reaction = reactionFor(e);
        expect(reaction).not.toBeNull();
        expect(reaction!.durationMs).toBeGreaterThan(0);
        expect(reaction!.durationMs).toBeLessThanOrEqual(FRANK_REACTION_MAX_MS);
        expect(reaction!.bubble ?? "").not.toMatch(/[\u2013\u2014]/);
      }),
      { numRuns: 400 }
    );
  });
});
