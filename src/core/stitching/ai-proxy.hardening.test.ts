/**
 * security-hardening, commit C: `/api/ai` fails closed on a bad counter reply,
 * and returns only the fields the client reads.
 */
import { describe, expect, it } from "vitest";
import {
  handleAiProxyRequest,
  parseLlmResponse,
  type AiProxyDeps,
  type LlmClient,
  type LlmCompletionInput,
  type RedisClient,
} from "./ai-proxy";

const BODY = JSON.stringify({ columns: [], candidates: [] });
const REPLY = JSON.stringify({ refinements: [{ id: "a=b", confidence: 0.9, reason: "same values" }] });

function deps(counts: unknown[]): { d: AiProxyDeps; llm: LlmCompletionInput[] } {
  const llm: LlmCompletionInput[] = [];
  let n = 0;
  const redis: RedisClient = { async incrWithTtl() { return counts[n++ % counts.length] as number; } };
  const llmClient: LlmClient = { async complete(i) { llm.push(i); return REPLY; } };
  return {
    llm,
    d: {
      env: { AI_PROVIDER: "openai", AI_MODEL: "m", IP_HASH_SALT: "s" },
      redis,
      llm: llmClient,
      now: () => 1_700_000_000_000,
      sha256Hex: async (x) => `h${x.length}`,
    },
  };
}
const post = () => ({ method: "POST", rawBody: BODY, clientIp: "1.2.3.4" });

const BAD_COUNTS: Array<[string, unknown]> = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a numeric string", "5"],
  ["a word", "abc"],
  ["null", null],
  ["undefined", undefined],
  ["zero", 0],
  ["a negative number", -3],
  ["a fraction", 1.5],
  ["an object", { n: 1 }],
];

describe("/api/ai counter replies", () => {
  it.each(BAD_COUNTS)("returns 503 and never calls the LLM when the per-client counter is %s", async (_n, bad) => {
    const { d, llm } = deps([bad]);
    const r = await handleAiProxyRequest(post(), d);
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toBe("unavailable");
    expect(llm).toHaveLength(0);
  });

  it.each(BAD_COUNTS)("returns 503 and never calls the LLM when the daily counter is %s", async (_n, bad) => {
    const { d, llm } = deps([1, bad]);
    const r = await handleAiProxyRequest(post(), d);
    expect(r.status).toBe(503);
    expect(llm).toHaveLength(0);
  });

  it("still serves a request with good counters", async () => {
    const { d, llm } = deps([1, 1]);
    const r = await handleAiProxyRequest(post(), d);
    expect(r.status).toBe(200);
    expect(llm).toHaveLength(1);
  });
});

describe("parseLlmResponse returns only the known fields", () => {
  it("drops extra top-level and per-refinement fields", () => {
    const out = parseLlmResponse(
      JSON.stringify({
        refinements: [{ id: "a=b", confidence: 0.9, reason: "r", extra: "x", nested: { k: 1 } }],
        apiKey: "sk-should-not-be-here",
        debug: true,
      })
    );
    expect(out).toEqual({ refinements: [{ id: "a=b", confidence: 0.9, reason: "r" }] });
  });

  it("drops a refinement with a wrong-typed field instead of passing it on", () => {
    const out = parseLlmResponse(
      JSON.stringify({
        refinements: [
          { id: "ok", confidence: 0.5, reason: "r" },
          { id: 7, confidence: 0.5, reason: "r" },
          { id: "x", confidence: "high", reason: "r" },
          { id: "y", confidence: 0.5, reason: { html: "<b>" } },
          null,
          "string",
        ],
      })
    );
    expect(out).toEqual({ refinements: [{ id: "ok", confidence: 0.5, reason: "r" }] });
  });

  it("still returns null for something that is not a refinements object", () => {
    expect(parseLlmResponse("not json")).toBeNull();
    expect(parseLlmResponse(JSON.stringify({ nope: [] }))).toBeNull();
    expect(parseLlmResponse(JSON.stringify({ refinements: "x" }))).toBeNull();
  });

  it("does not copy a polluted prototype key", () => {
    const out = parseLlmResponse('{"refinements":[],"__proto__":{"polluted":true}}');
    expect(out).toEqual({ refinements: [] });
    expect((out as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
