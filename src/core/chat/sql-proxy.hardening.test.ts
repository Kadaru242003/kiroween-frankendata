/**
 * security-hardening, commit C: `/api/sql` fails closed on a bad counter reply,
 * and returns only the fields the client reads.
 */
import { describe, expect, it } from "vitest";
import { handleSqlProxyRequest, parseSqlLlmResponse, type SqlProxyDeps } from "./sql-proxy";
import type { LlmClient, LlmCompletionInput, RedisClient } from "../stitching/ai-proxy";

const BODY = JSON.stringify({ question: "q", schema: { tables: [] } });
const REPLY = JSON.stringify({ sql: "SELECT 1", explanation: "One." });

function deps(counts: unknown[], reply = REPLY): { d: SqlProxyDeps; llm: LlmCompletionInput[] } {
  const llm: LlmCompletionInput[] = [];
  let n = 0;
  const redis: RedisClient = { async incrWithTtl() { return counts[n++ % counts.length] as number; } };
  const llmClient: LlmClient = { async complete(i) { llm.push(i); return reply; } };
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

describe("/api/sql counter replies", () => {
  it.each(BAD_COUNTS)("returns 503 and never calls the LLM when the per-client counter is %s", async (_n, bad) => {
    const { d, llm } = deps([bad]);
    const r = await handleSqlProxyRequest(post(), d);
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toBe("unavailable");
    expect(llm).toHaveLength(0);
  });

  it.each(BAD_COUNTS)("returns 503 and never calls the LLM when the daily counter is %s", async (_n, bad) => {
    const { d, llm } = deps([1, bad]);
    const r = await handleSqlProxyRequest(post(), d);
    expect(r.status).toBe(503);
    expect(llm).toHaveLength(0);
  });

  it("still serves a request with good counters", async () => {
    const { d, llm } = deps([1, 1]);
    const r = await handleSqlProxyRequest(post(), d);
    expect(r.status).toBe(200);
    expect(llm).toHaveLength(1);
  });
});

describe("parseSqlLlmResponse returns only the known fields", () => {
  it("drops extra fields", () => {
    const out = parseSqlLlmResponse(
      JSON.stringify({ sql: "SELECT 1", explanation: "One.", secret: "x", chart: { type: "bar", x: "a", y: "b", color: "red" }, debug: 1 })
    );
    expect(out).toEqual({ sql: "SELECT 1", explanation: "One.", chart: { type: "bar", x: "a", y: "b" } });
  });

  it("omits a chart that is not a well-formed spec", () => {
    for (const chart of ["bar", 3, null, [], { type: "bar" }, { type: 1, x: "a", y: "b" }, { type: "bar", x: "a", y: {} }]) {
      const out = parseSqlLlmResponse(JSON.stringify({ sql: "SELECT 1", explanation: "One.", chart }));
      expect(out).toEqual({ sql: "SELECT 1", explanation: "One." });
    }
  });

  it("omits the chart key when there is none", () => {
    const out = parseSqlLlmResponse(JSON.stringify({ sql: "SELECT 1", explanation: "One." }));
    expect(out).toEqual({ sql: "SELECT 1", explanation: "One." });
    expect(out && "chart" in out).toBe(false);
  });

  it("still returns null without a string sql and explanation", () => {
    expect(parseSqlLlmResponse("nope")).toBeNull();
    expect(parseSqlLlmResponse(JSON.stringify({ sql: 1, explanation: "x" }))).toBeNull();
    expect(parseSqlLlmResponse(JSON.stringify({ sql: "SELECT 1" }))).toBeNull();
  });

  it("does not copy a polluted prototype key", () => {
    const out = parseSqlLlmResponse('{"sql":"SELECT 1","explanation":"x","__proto__":{"polluted":true}}');
    expect(out).toEqual({ sql: "SELECT 1", explanation: "x" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reaches the client body without extras through the handler", async () => {
    const { d } = deps([1, 1], JSON.stringify({ sql: "SELECT 1", explanation: "One.", apiKey: "sk-nope" }));
    const r = await handleSqlProxyRequest(post(), d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sql: "SELECT 1", explanation: "One." });
  });
});
