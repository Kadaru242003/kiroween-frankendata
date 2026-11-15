/**
 * Feature: frankendata-little-frank, Property 4: poke escalation. Defined for
 * every count; never friendlier while the count rises; the egg plays exactly at
 * the egg count.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FRANK_POKE_EGG_COUNT, FRANK_POKE_RESET_MS } from "./constants";
import { NO_POKES, pokeLevel, pokeReaction, pokeStep } from "./reactions";

describe("Feature: frankendata-little-frank, Property 4: poke escalation", () => {
  it("is defined for any count and never goes back to a friendlier level", () => {
    fc.assert(
      fc.property(fc.integer({ min: -3, max: 200 }), (n) => {
        expect(pokeReaction(n).id).toMatch(/^poke-/);
        if (n >= 1) expect(pokeLevel(n + 1)).toBeGreaterThanOrEqual(pokeLevel(n));
      })
    );
  });
  it("plays the egg exactly at the egg count when pokes come without a pause", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 500 }), (pokes, gap) => {
        let state = NO_POKES;
        let eggs = 0;
        for (let i = 1; i <= pokes; i++) {
          const step = pokeStep(state, i * gap);
          state = step.state;
          if (step.reaction.id === "poke-egg") {
            eggs += 1;
            expect(i % FRANK_POKE_EGG_COUNT).toBe(0);
          }
        }
        expect(eggs).toBe(Math.floor(pokes / FRANK_POKE_EGG_COUNT));
      })
    );
  });
  it("starts again after a long pause", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), (k) => {
        let state = NO_POKES;
        for (let i = 0; i < k; i++) state = pokeStep(state, i * 10).state;
        expect(pokeStep(state, k * 10 + FRANK_POKE_RESET_MS + 5).reaction.id).toBe("poke-1");
      })
    );
  });
});
