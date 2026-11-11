/**
 * Unit tests for the serverless SqlProxy core logic (Feature 3, task 8).
 *
 * Drives {@link handleSqlProxyRequest} with a MOCKED Redis counter store and a
 * MOCKED LLM upstream — no real network, Redis, or provider. Covers the
 * 400/403/405/413/429/503 paths, the happy path, and the two deliberate
 * differences from the AI proxy: the OWN `rlsql:` per-client key prefix and the
 * SHARED `cap:<day>` daily-cap key (Req 4.1–4.8).
 */

import { describe, expect, it } from "vitest";
import {
  AI_PROXY_DAILY_REQUEST_CAP,
  AI_PROXY_MAX_PAYLOAD_BYTES,
  AI_PROXY_PER_CLIENT_LIMIT,
  handleSqlProxyRequest,
  type SqlProxyDeps,
  type SqlProxyResult,
} from "./sql-proxy";
import type {
  AiProxyEnv,
  AiProxyHttpRequest,
  LlmClient,
  LlmCompletionInput,
  RedisClient,
} from "../stitching/ai-proxy";
import type { SqlRequest } from "./types";

const VALID_REQUEST: SqlRequest = {
  question: "how many monsters per species",
  schema: {
    tables: [
      {
        tableName: "monsters",
        columns: [
          { name: "species", type: "string", samples: ["ghost", "vamp"] },
          { name: "power", type: "number", samples: ["10", "20"] },
        ],
      },
    ],
  },
};

const GOOD_ENV: AiProxyEnv = {
  AI_PROVIDER: "openai",
  AI_MODEL: "test-model-x",
  IP_HASH_SALT: "pepper",
};

const GOOD_REPLY = JSON.stringify({
  sql: "SELECT species, COUNT(*) AS count FROM monsters GROUP BY species",
  explanation: "Counts rows per species.",
  chart: { type: "bar", x: "species", y: "count" },
});

function fakeRedis(opts?: {
  counts?: Record<string, number>;
  throwOnCall?: number;
}): RedisClient & { calls: string[] } {
  const store = new Map<string, number>();
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async incrWithTtl(key: string): Promise<number> {
      n += 1;
      calls.push(key);
      if (opts?.throwOnCall === n) throw new Error("redis down");
      let primed = 0;
      if (opts?.counts) {
        for (const [prefix, v] of Object.entries(opts.counts)) {
          if (key.startsWith(prefix)) primed = v;
        }
      }
      const current = (store.get(key) ?? primed) + 1;
      store.set(key, current);
      return current;
    },
  };
}

function fakeLlm(opts?: { reply?: string; throws?: boolean }): LlmClient & {
  calls: LlmCompletionInput[];
} {
  const calls: LlmCompletionInput[] = [];
  return {
    calls,
    async complete(input: LlmCompletionInput): Promise<string> {
      calls.push(input);
      if (opts?.throws) throw new Error("upstream down");
      return opts?.reply ?? GOOD_REPLY;
    },
  };
}

const fakeSha: NonNullable<SqlProxyDeps["sha256Hex"]> = async (input) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `h${h.toString(16).padStart(8, "0")}`;
};

const FIXED_NOW = () => 1_700_000_000_000;

function makeReq(overrides?: Partial<AiProxyHttpRequest>): AiProxyHttpRequest {
  return {
    method: overrides?.method ?? "POST",
    rawBody: overrides?.rawBody ?? JSON.stringify(VALID_REQUEST),
    origin: overrides?.origin,
    clientIp: overrides?.clientIp ?? "203.0.113.5",
  };
}

function makeDeps(overrides?: Partial<SqlProxyDeps>): SqlProxyDeps {
  return {
    env: overrides?.env ?? GOOD_ENV,
    redis: overrides?.redis ?? fakeRedis(),
    llm: overrides?.llm ?? fakeLlm(),
    log: overrides?.log,
    now: overrides?.now ?? FIXED_NOW,
    sha256Hex: overrides?.sha256Hex ?? fakeSha,
  };
}

function errorCode(result: SqlProxyResult): string | undefined {
  return (result.body as { error?: string }).error;
}

describe("handleSqlProxyRequest — happy path", () => {
  it("returns 200 with { sql, explanation, chart } and reads provider+model from env", async () => {
    const llm = fakeLlm();
    const result = await handleSqlProxyRequest(makeReq(), makeDeps({ llm }));
    expect(result.status).toBe(200);
    const body = result.body as { sql: string; explanation: string };
    expect(body.sql).toContain("SELECT");
    expect(typeof body.explanation).toBe("string");
    expect(llm.calls[0].provider).toBe("openai");
    expect(llm.calls[0].model).toBe("test-model-x");
    expect(llm.calls[0].maxOutputTokens).toBeGreaterThan(0);
  });

  it("declares schema+question untrusted and sends only question+schema as JSON", async () => {
    const llm = fakeLlm();
    await handleSqlProxyRequest(makeReq(), makeDeps({ llm }));
    const { systemPrompt, userPrompt } = llm.calls[0];
    expect(systemPrompt.toLowerCase()).toContain("untrusted");
    expect(systemPrompt.toLowerCase()).toContain("json only");
    const parsed = JSON.parse(userPrompt) as SqlRequest;
    expect(parsed.question).toBe(VALID_REQUEST.question);
    expect(parsed.schema.tables[0].tableName).toBe("monsters");
  });
});

describe("handleSqlProxyRequest — method / env / size", () => {
  it("rejects non-POST with 405", async () => {
    const llm = fakeLlm();
    const r = await handleSqlProxyRequest(makeReq({ method: "GET" }), makeDeps({ llm }));
    expect(r.status).toBe(405);
    expect(llm.calls).toHaveLength(0);
  });

  for (const missing of ["AI_PROVIDER", "AI_MODEL", "IP_HASH_SALT"] as const) {
    it(`returns 503 with no upstream when ${missing} is missing`, async () => {
      const env = { ...GOOD_ENV, [missing]: undefined };
      const llm = fakeLlm();
      const redis = fakeRedis();
      const r = await handleSqlProxyRequest(makeReq(), makeDeps({ env, llm, redis }));
      expect(r.status).toBe(503);
      expect(errorCode(r)).toBe("unavailable");
      expect(llm.calls).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
    });
  }

  it("rejects an oversized body with 413", async () => {
    const rawBody = "x".repeat(AI_PROXY_MAX_PAYLOAD_BYTES + 1);
    const llm = fakeLlm();
    const r = await handleSqlProxyRequest(makeReq({ rawBody }), makeDeps({ llm }));
    expect(r.status).toBe(413);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("handleSqlProxyRequest — schema rejection (400)", () => {
  it("rejects malformed JSON", async () => {
    const r = await handleSqlProxyRequest(makeReq({ rawBody: "{ not json" }), makeDeps());
    expect(r.status).toBe(400);
  });

  it("rejects an unknown top-level field", async () => {
    const body = { ...VALID_REQUEST, extra: 1 };
    const r = await handleSqlProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(r.status).toBe(400);
  });

  it("rejects a question over the char limit", async () => {
    const body = { ...VALID_REQUEST, question: "x".repeat(301) };
    const r = await handleSqlProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(r.status).toBe(400);
  });

  it("rejects an invalid column type in the schema", async () => {
    const body = {
      question: "q",
      schema: { tables: [{ tableName: "t", columns: [{ name: "c", type: "wat", samples: [] }] }] },
    };
    const r = await handleSqlProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(r.status).toBe(400);
  });

  it("rejects an unknown field inside the repair object", async () => {
    const body = { ...VALID_REQUEST, repair: { previousSql: "x", error: "y", sneaky: 1 } };
    const r = await handleSqlProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(r.status).toBe(400);
  });

  it("accepts a valid repair follow-up", async () => {
    const body = { ...VALID_REQUEST, repair: { previousSql: "SELECT 1", error: "boom" } };
    const r = await handleSqlProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(r.status).toBe(200);
  });
});

describe("handleSqlProxyRequest — origin (403)", () => {
  const env: AiProxyEnv = { ...GOOD_ENV, ALLOWED_ORIGINS: "https://frankendata.example" };
  it("allows an origin on the list", async () => {
    const r = await handleSqlProxyRequest(
      makeReq({ origin: "https://frankendata.example" }),
      makeDeps({ env })
    );
    expect(r.status).toBe(200);
  });
  it("rejects an origin not on the list", async () => {
    const r = await handleSqlProxyRequest(
      makeReq({ origin: "https://evil.example" }),
      makeDeps({ env })
    );
    expect(r.status).toBe(403);
  });
});

describe("handleSqlProxyRequest — counters (429 / fail-closed)", () => {
  it("rejects over the per-client limit under the rlsql: prefix", async () => {
    const redis = fakeRedis({ counts: { "rlsql:": AI_PROXY_PER_CLIENT_LIMIT } });
    const llm = fakeLlm();
    const r = await handleSqlProxyRequest(makeReq(), makeDeps({ redis, llm }));
    expect(r.status).toBe(429);
    expect(errorCode(r)).toBe("rate_limited");
    expect(llm.calls).toHaveLength(0);
    // The per-client key uses the OWN rlsql: prefix (not the AI proxy's rl:).
    expect(redis.calls.some((k) => k.startsWith("rlsql:"))).toBe(true);
    expect(redis.calls.some((k) => k.startsWith("rl:") && !k.startsWith("rlsql:"))).toBe(false);
  });

  it("rejects over the SHARED global daily cap with a cap marker", async () => {
    const redis = fakeRedis({ counts: { "cap:": AI_PROXY_DAILY_REQUEST_CAP } });
    const llm = fakeLlm();
    const r = await handleSqlProxyRequest(makeReq(), makeDeps({ redis, llm }));
    expect(r.status).toBe(429);
    expect(errorCode(r)).toBe("daily_cap");
    expect((r.body as { cap?: true }).cap).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("increments the SAME cap:<day> key the AI proxy uses (shared cap)", async () => {
    const redis = fakeRedis();
    await handleSqlProxyRequest(makeReq(), makeDeps({ redis }));
    // The day bucket for the fixed clock.
    const expectedCapKey = `cap:${Math.floor(FIXED_NOW() / 86_400_000)}`;
    expect(redis.calls).toContain(expectedCapKey);
  });

  it("fails closed (503, no upstream) when the per-client incr throws", async () => {
    const redis = fakeRedis({ throwOnCall: 1 });
    const llm = fakeLlm();
    const r = await handleSqlProxyRequest(makeReq(), makeDeps({ redis, llm }));
    expect(r.status).toBe(503);
    expect(llm.calls).toHaveLength(0);
  });

  it("fails closed (503, no upstream) when the global-cap incr throws", async () => {
    const redis = fakeRedis({ throwOnCall: 2 });
    const llm = fakeLlm();
    const r = await handleSqlProxyRequest(makeReq(), makeDeps({ redis, llm }));
    expect(r.status).toBe(503);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("handleSqlProxyRequest — upstream (503) + logging", () => {
  it("returns 503 when the upstream throws", async () => {
    const llm = fakeLlm({ throws: true });
    const r = await handleSqlProxyRequest(makeReq(), makeDeps({ llm }));
    expect(r.status).toBe(503);
    expect(llm.calls).toHaveLength(1);
  });

  it("returns 503 when the output is not a valid SQL response", async () => {
    const llm = fakeLlm({ reply: '{"explanation":"missing sql"}' });
    const r = await handleSqlProxyRequest(makeReq(), makeDeps({ llm }));
    expect(r.status).toBe(503);
  });

  it("tolerates a ```json fenced response", async () => {
    const llm = fakeLlm({ reply: "```json\n" + GOOD_REPLY + "\n```" });
    const r = await handleSqlProxyRequest(makeReq(), makeDeps({ llm }));
    expect(r.status).toBe(200);
  });

  it("logs only coarse metadata — never the question or sample values", async () => {
    const logged: unknown[] = [];
    await handleSqlProxyRequest(makeReq(), makeDeps({ log: (m) => logged.push(m) }));
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("how many monsters per species");
    expect(serialized).not.toContain("ghost");
    expect(serialized).toContain('"status":200');
  });
});
