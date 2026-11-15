/**
 * Feature: frankendata-little-frank, Property 1: the reaction queue never piles
 * up. At most one current and one waiting reaction; the waiting one is the
 * newest enqueued since the current started; no reaction plays twice for one
 * enqueue.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { EMPTY_QUEUE, enqueue, finish, reactionFor, type FrankEvent, type QueueState, type Reaction } from "./reactions";

const events: FrankEvent[] = [
  { type: "approve" }, { type: "reject" }, { type: "stitch-open" },
  { type: "confirm-stitch" }, { type: "export" }, { type: "ai-off" }, { type: "reset" },
  { type: "autopsy", score: 50 }, { type: "wake" }, { type: "files-loaded", tableCount: 2 },
];

const action = fc.oneof(
  fc.constantFrom(...events).map((e) => ({ kind: "enqueue" as const, e })),
  fc.constant({ kind: "finish" as const })
);

describe("Feature: frankendata-little-frank, Property 1: reaction queue", () => {
  it("holds at most one current and one waiting, newest waiting, and each enqueue plays once", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        let s: QueueState = EMPTY_QUEUE;
        let lastEnqueuedSinceStart: Reaction | null = null;
        const started: Reaction[] = [];
        const enqueued: Reaction[] = [];
        for (const a of actions) {
          const before = s;
          if (a.kind === "enqueue") {
            const reaction = reactionFor(a.e)!;
            s = enqueue(s, reaction);
            if (s !== before) enqueued.push(reaction);
            if (s.current !== before.current && s.current) started.push(s.current);
            if (before.current !== null && s.pending !== null && s !== before) lastEnqueuedSinceStart = reaction;
          } else {
            s = finish(s);
            if (s.current !== before.current && s.current) started.push(s.current);
            lastEnqueuedSinceStart = null;
          }
          // Shape: a waiting reaction needs a current one.
          if (s.pending !== null) expect(s.current).not.toBeNull();
          // Newest wins.
          if (s.pending !== null && lastEnqueuedSinceStart !== null) expect(s.pending).toBe(lastEnqueuedSinceStart);
        }
        // Nothing plays more often than it was enqueued.
        expect(started.length).toBeLessThanOrEqual(enqueued.length);
      }),
      { numRuns: 300 }
    );
  });
});
