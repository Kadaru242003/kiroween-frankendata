/**
 * Feature: frankendata-smarter-ask, Property 2: the request payload with a
 * thread never exceeds the cap, and the newest turns that fit are kept.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AI_PROXY_MAX_PAYLOAD_BYTES } from "../stitching/types";
import { fitRequestToCap, requestBytes } from "./thread";
import type { SqlRequest, ThreadTurn } from "./types";

const turnArb: fc.Arbitrary<ThreadTurn> = fc.record({
  question: fc.string({ maxLength: 300 }),
  sql: fc.string({ maxLength: 1000 }),
  columns: fc.array(fc.string({ maxLength: 60 }), { maxLength: 40 }),
  rowCount: fc.nat(100000),
});

describe("Feature: frankendata-smarter-ask, Property 2: payload cap", () => {
  it("fits the cap and keeps the newest fitting turns", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.integer({ min: 0, max: 20000 }),
        fc.array(turnArb, { maxLength: 3 }),
        (question, schemaPad, thread) => {
          const request: SqlRequest = {
            question,
            schema: {
              tables: [{ tableName: "t", columns: [{ name: "pad".padEnd(schemaPad % 4000, "p"), type: "string", samples: [] }] }],
            },
            thread,
          };
          const fitted = fitRequestToCap(request);
          const withoutThread = requestBytes({ ...request, thread: undefined });
          if (withoutThread <= AI_PROXY_MAX_PAYLOAD_BYTES) {
            expect(requestBytes(fitted)).toBeLessThanOrEqual(AI_PROXY_MAX_PAYLOAD_BYTES);
          }
          const kept = fitted.thread ?? [];
          // The kept turns are a suffix (newest) of the input thread.
          expect(thread.slice(thread.length - kept.length)).toEqual(kept);
          // Dropping one fewer old turn would not have fit (or all are kept).
          if (kept.length < thread.length && withoutThread <= AI_PROXY_MAX_PAYLOAD_BYTES) {
            const bigger = { ...request, thread: thread.slice(thread.length - kept.length - 1) };
            expect(requestBytes(bigger)).toBeGreaterThan(AI_PROXY_MAX_PAYLOAD_BYTES);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
