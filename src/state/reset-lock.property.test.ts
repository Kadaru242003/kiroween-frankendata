/**
 * Feature: frankendata-smarter-ask, Property 4: Reset lab never leaves the load
 * controls enabled while it runs, and always releases them afterwards.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadControlsEnabled, ResetLock } from "./reset-lock";

describe("Feature: frankendata-smarter-ask, Property 4: reset lock", () => {
  it("controls are disabled for the whole run and enabled after, even on failure", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 1, max: 5 }),
        async (fails, ticks, extraAttempts) => {
          const lock = new ResetLock();
          const observed: boolean[] = [];
          const run = lock.run(async () => {
            for (let i = 0; i <= ticks; i++) {
              observed.push(loadControlsEnabled(lock.getState()));
              for (let k = 0; k < extraAttempts; k++) {
                // Concurrent resets and reads while running.
                expect(await lock.run(async () => {})).toBe(false);
                observed.push(loadControlsEnabled(lock.getState()));
              }
              await Promise.resolve();
            }
            if (fails) throw new Error("reset failed");
          });
          observed.push(loadControlsEnabled(lock.getState()));
          await run.catch(() => undefined);
          expect(observed.every((e) => e === false)).toBe(true);
          expect(loadControlsEnabled(lock.getState())).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
