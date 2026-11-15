import { describe, expect, it } from "vitest";
import { handleSqlProxyRequest, type SqlProxyDeps } from "./sql-proxy";
import type { LlmClient, LlmCompletionInput, RedisClient } from "../stitching/ai-proxy";
import type { SqlRequest } from "./types";

const BASE: SqlRequest = {
  question: "now only the High ones",
  schema: { tables: [{ tableName: "monsters", columns: [{ name: "level", type: "string", samples: ["High"] }] }] },
};
const THREAD = [
  { question: "how many per level", sql: "SELECT level, COUNT(*) AS n FROM monsters GROUP BY level", columns: ["level", "n"], rowCount: 3 },
];
const REPLY = JSON.stringify({ sql: "SELECT * FROM monsters WHERE level = 'High'", explanation: "Filters to High." });

function deps(): { d: SqlProxyDeps; llm: LlmCompletionInput[]; redis: string[] } {
  const llm: LlmCompletionInput[] = [];
  const redis: string[] = [];
  const llmClient: LlmClient = { async complete(i) { llm.push(i); return REPLY; } };
  const redisClient: RedisClient = { async incrWithTtl(k) { redis.push(k); return 1; } };
  return {
    llm,
    redis,
    d: {
      env: { AI_PROVIDER: "openai", AI_MODEL: "m", IP_HASH_SALT: "s" },
      redis: redisClient,
      llm: llmClient,
      now: () => 1_700_000_000_000,
      sha256Hex: async (x) => `h${x.length}`,
    },
  };
}
const post = (body: unknown) => ({ method: "POST", rawBody: JSON.stringify(body), clientIp: "1.2.3.4" });

describe("sql proxy with a thread", () => {
  it("accepts a valid thread and passes it in the user prompt", async () => {
    const { d, llm } = deps();
    const r = await handleSqlProxyRequest(post({ ...BASE, thread: THREAD }), d);
    expect(r.status).toBe(200);
    const prompt = JSON.parse(llm[0].userPrompt);
    expect(prompt.thread).toEqual(THREAD);
    expect(llm[0].systemPrompt).toContain("THREAD");
  });
  it("is unchanged without a thread (no thread key in the prompt)", async () => {
    const { d, llm } = deps();
    const r = await handleSqlProxyRequest(post(BASE), d);
    expect(r.status).toBe(200);
    expect("thread" in JSON.parse(llm[0].userPrompt)).toBe(false);
  });
  it.each([
    ["too many turns", [THREAD[0], THREAD[0], THREAD[0], THREAD[0]]],
    ["unknown key", [{ ...THREAD[0], rows: [["x"]] }]],
    ["row values smuggled as columns type", [{ ...THREAD[0], columns: [1] }]],
    ["negative count", [{ ...THREAD[0], rowCount: -1 }]],
    ["fractional count", [{ ...THREAD[0], rowCount: 1.5 }]],
    ["overlong sql", [{ ...THREAD[0], sql: "x".repeat(1001) }]],
    ["not an array", { question: "q" }],
  ])("rejects %s with bad_request and no counters or LLM", async (_n, thread) => {
    const { d, llm, redis } = deps();
    const r = await handleSqlProxyRequest(post({ ...BASE, thread }), d);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("bad_request");
    expect(llm).toHaveLength(0);
    expect(redis).toHaveLength(0);
  });
  it("keeps the shared payload cap", async () => {
    const { d } = deps();
    const big = { ...BASE, thread: THREAD, pad: "x" };
    const r = await handleSqlProxyRequest({ ...post(big), rawBody: JSON.stringify(big) + " ".repeat(25000) }, d);
    expect(r.status).toBe(413);
  });
});
