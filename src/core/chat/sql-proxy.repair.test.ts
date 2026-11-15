import { describe, expect, it } from "vitest";
import { handleSqlProxyRequest, type SqlProxyDeps } from "./sql-proxy";
import type { LlmClient, LlmCompletionInput, RedisClient } from "../stitching/ai-proxy";
import {
  ASK_REPAIR_ERROR_MAX_CHARS,
  ASK_REPAIR_SQL_MAX_CHARS,
  ASK_SCHEMA_MAX_NAME_CHARS,
  type SqlRequest,
} from "./types";

const BASE: SqlRequest = {
  question: "q",
  schema: { tables: [{ tableName: "monsters", columns: [{ name: "level", type: "string", samples: ["High"] }] }] },
};
const REPLY = JSON.stringify({ sql: "SELECT 1", explanation: "x" });

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
const withTable = (tableName: string, name: string): SqlRequest => ({
  ...BASE,
  schema: { tables: [{ tableName, columns: [{ name, type: "string", samples: [] }] }] },
});

describe("sql proxy length limits", () => {
  it("accepts values at the limits", async () => {
    for (const body of [
      { ...BASE, repair: { previousSql: "x".repeat(ASK_REPAIR_SQL_MAX_CHARS), error: "e".repeat(ASK_REPAIR_ERROR_MAX_CHARS) } },
      withTable("t".repeat(ASK_SCHEMA_MAX_NAME_CHARS), "c".repeat(ASK_SCHEMA_MAX_NAME_CHARS)),
    ]) {
      const { d } = deps();
      expect((await handleSqlProxyRequest(post(body), d)).status).toBe(200);
    }
  });

  it.each([
    ["repair.error over the cap", { ...BASE, repair: { previousSql: "SELECT 1", error: "e".repeat(ASK_REPAIR_ERROR_MAX_CHARS + 1) } }],
    ["repair.previousSql over the cap", { ...BASE, repair: { previousSql: "x".repeat(ASK_REPAIR_SQL_MAX_CHARS + 1), error: "e" } }],
    ["tableName over the cap", withTable("t".repeat(ASK_SCHEMA_MAX_NAME_CHARS + 1), "c")],
    ["column name over the cap", withTable("t", "c".repeat(ASK_SCHEMA_MAX_NAME_CHARS + 1))],
  ])("rejects %s with bad_request and no counters or LLM", async (_n, body) => {
    const { d, llm, redis } = deps();
    const r = await handleSqlProxyRequest(post(body), d);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("bad_request");
    expect(llm).toHaveLength(0);
    expect(redis).toHaveLength(0);
  });
});
