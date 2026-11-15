/**
 * Feature: frankendata-little-frank, Property 7: quip scheduler. Following the
 * scheduler over any sequence of times, two quips are never closer than the gap,
 * and none ever plays while busy or asleep.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FRANK_QUIP_GAP_MS, FRANK_QUIP_QUIET_MS } from "./constants";
import { QUIP_KINDS, pickQuip, quipDue } from "./quips";

describe("Feature: frankendata-little-frank, Property 7: quip scheduler", () => {
  it("never plays two quips closer than the gap, nor while busy or asleep", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dt: fc.integer({ min: 0, max: 90_000 }),
            quietFor: fc.integer({ min: 0, max: 200_000 }),
            busy: fc.boolean(),
            awake: fc.boolean(),
          }),
          { maxLength: 80 }
        ),
        (steps) => {
          let now = 0;
          let lastQuipAt = 0;
          const played: number[] = [];
          for (const step of steps) {
            now += step.dt;
            const due = quipDue({
              now,
              lastQuipAt,
              lastActivityAt: now - step.quietFor,
              busy: step.busy,
              awake: step.awake,
            });
            if (due) {
              expect(step.busy).toBe(false);
              expect(step.awake).toBe(true);
              expect(step.quietFor).toBeGreaterThanOrEqual(FRANK_QUIP_QUIET_MS);
              played.push(now);
              lastQuipAt = now;
            }
          }
          for (let i = 1; i < played.length; i += 1) {
            expect(played[i] - played[i - 1]).toBeGreaterThanOrEqual(FRANK_QUIP_GAP_MS);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("never repeats the last quip", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(...QUIP_KINDS), (roll, last) => {
        expect(pickQuip(roll, last)).not.toBe(last);
      })
    );
  });
});
