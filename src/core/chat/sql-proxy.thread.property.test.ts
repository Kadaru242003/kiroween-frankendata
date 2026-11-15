/**
 * Feature: frankendata-smarter-ask, Property 5: a malformed thread is rejected
 * with 400 bad_request, and the LLM and the counters are never touched.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { handleSqlProxyRequest } from "./sql-proxy";
import type { LlmCompletionInput } from "../stitching/ai-proxy";

const BASE = { question: "q", schema: { tables: [] as unknown[] } };
const good = { question: "q", sql: "SELECT 1", columns: ["a"], rowCount: 1 };

const bad = fc.oneof(
  fc.array(fc.constant(good), { minLength: 4, maxLength: 6 }),
  fc.constant([{ ...good, extra: 1 }]),
  fc.constant([{ ...good, sql: "x".repeat(1001) }]),
  fc.constant([{ ...good, question: "x".repeat(301) }]),
  fc.constant([{ ...good, columns: Array.from({ length: 41 }, () => "c") }]),
  fc.constant([{ ...good, columns: ["x".repeat(61)] }]),
  fc.constant([{ ...good, columns: [5] }]),
  fc.oneof(fc.constant(-1), fc.constant(1.5), fc.constant("3"), fc.constant(null), fc.constant(Number.MAX_VALUE)).map((rowCount) => [{ ...good, rowCount }]),
  fc.oneof(fc.constant({}), fc.constant("t"), fc.constant(7), fc.constant(null), fc.constant([null]), fc.constant([[]]))
);

describe("Feature: frankendata-smarter-ask, Property 5: proxy thread validation", () => {
  it("rejects every malformed thread before the counters or the LLM", async () => {
    await fc.assert(
      fc.asyncProperty(bad, async (thread) => {
        const llm: LlmCompletionInput[] = [];
        const redis: string[] = [];
        const r = await handleSqlProxyRequest(
          { method: "POST", rawBody: JSON.stringify({ ...BASE, thread }), clientIp: "1.1.1.1" },
          {
            env: { AI_PROVIDER: "openai", AI_MODEL: "m", IP_HASH_SALT: "s" },
            redis: { async incrWithTtl(k) { redis.push(k); return 1; } },
            llm: { async complete(i) { llm.push(i); return "{}"; } },
            sha256Hex: async () => "h",
          }
        );
        expect(r.status).toBe(400);
        expect(llm).toHaveLength(0);
        expect(redis).toHaveLength(0);
      }),
      { numRuns: 200 }
    );
  });
});
