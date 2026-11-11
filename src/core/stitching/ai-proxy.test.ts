/**
 * Unit tests for the serverless AiProxy core logic (Feature 2, task 21).
 *
 * Every test drives {@link handleAiProxyRequest} with a MOCKED Redis counter
 * store and a MOCKED LLM upstream — no real network, no real Redis, no real
 * provider (Req 11.1, 11.2). The pinned constants are imported from the single
 * source of truth (`types.ts`, re-exported by `ai-proxy.ts`).
 *
 * Coverage:
 *   - schema rejection: unknown/extra fields and oversized arrays → 400
 *   - payload too large (> AI_PROXY_MAX_PAYLOAD_BYTES) → 413
 *   - Origin not allowed → 403
 *   - per-client hourly limit exceeded → 429 (rate_limited)
 *   - global daily cap → 429 with a `cap` marker
 *   - Redis unreachable → fail closed (503) WITHOUT any upstream call
 *   - missing required env → 503 WITHOUT any upstream call
 *   - happy path: 200 with refinements; provider+model read from env;
 *     SampleValues never logged
 */

import { describe, expect, it, vi } from "vitest";
import {
  AI_PROXY_DAILY_REQUEST_CAP,
  AI_PROXY_MAX_CANDIDATES,
  AI_PROXY_MAX_COLUMNS,
  AI_PROXY_MAX_PAYLOAD_BYTES,
  AI_PROXY_MAX_SAMPLES_PER_COLUMN,
  AI_PROXY_PER_CLIENT_LIMIT,
  handleAiProxyRequest,
  type AiProxyDeps,
  type AiProxyEnv,
  type AiProxyHttpRequest,
  type AiProxyResult,
  type LlmClient,
  type LlmCompletionInput,
  type ProxyLogMeta,
  type RedisClient,
} from "./ai-proxy";
import type { AiRequest } from "./types";

// ── Fixtures ────────────────────────────────────────────────────────────────

const VALID_REQUEST: AiRequest = {
  columns: [
    {
      tableName: "monsters",
      columnName: "Monster Name",
      type: "string",
      samples: ["Swamp Wraith", "Bog Golem"],
    },
    {
      tableName: "experiments",
      columnName: "name",
      type: "string",
      samples: ["Swamp Wraith", "Night Howler"],
    },
  ],
  candidates: [
    {
      id: "monsters.Monster Name~experiments.name",
      left: { tableName: "monsters", columnName: "Monster Name" },
      right: { tableName: "experiments", columnName: "name" },
      ruleConfidence: 0.78,
    },
  ],
};

const GOOD_ENV: AiProxyEnv = {
  AI_PROVIDER: "openai",
  AI_MODEL: "test-model-x",
  IP_HASH_SALT: "pepper",
  // No ALLOWED_ORIGINS → courtesy check disabled (allowed) by default.
};

/** A Redis double whose per-key counts are scripted/observable. */
function fakeRedis(opts?: {
  counts?: Record<string, number>; // prime an existing count for a key prefix match
  throwOnCall?: number; // throw on the Nth incr call (1-based)
}): RedisClient & { calls: string[] } {
  const store = new Map<string, number>();
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async incrWithTtl(key: string): Promise<number> {
      n += 1;
      calls.push(key);
      if (opts?.throwOnCall === n) {
        throw new Error("redis down");
      }
      // Allow priming by key prefix (so hour/day buckets don't need exact keys).
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

/** An LLM double that records whether/what it was called with. */
function fakeLlm(opts?: {
  reply?: string;
  throws?: boolean;
}): LlmClient & { calls: LlmCompletionInput[] } {
  const calls: LlmCompletionInput[] = [];
  return {
    calls,
    async complete(input: LlmCompletionInput): Promise<string> {
      calls.push(input);
      if (opts?.throws) throw new Error("upstream down");
      return (
        opts?.reply ??
        JSON.stringify({
          refinements: [
            {
              id: "monsters.Monster Name~experiments.name",
              confidence: 0.93,
              reason: "Strong value overlap.",
            },
          ],
        })
      );
    },
  };
}

/**
 * A deterministic SHA-256 stub (avoids crypto setup) that, like a real digest,
 * does NOT embed its input verbatim — it folds the input into a fixed-width hex
 * string. Still a pure function of the (ip + salt) input, so distinct inputs map
 * to distinct hashes, but the raw IP never leaks into the output.
 */
const fakeSha256: NonNullable<AiProxyDeps["sha256Hex"]> = async (input) => {
  let h = 0x811c9dc5; // FNV-1a seed
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `h${h.toString(16).padStart(8, "0")}`;
};

const FIXED_NOW = () => 1_700_000_000_000; // fixed ms so bucket keys are stable

function makeReq(overrides?: Partial<AiProxyHttpRequest>): AiProxyHttpRequest {
  const rawBody = overrides?.rawBody ?? JSON.stringify(VALID_REQUEST);
  return {
    method: overrides?.method ?? "POST",
    rawBody,
    origin: overrides?.origin,
    clientIp: overrides?.clientIp ?? "203.0.113.5",
  };
}

function makeDeps(overrides?: Partial<AiProxyDeps>): AiProxyDeps {
  return {
    env: overrides?.env ?? GOOD_ENV,
    redis: overrides?.redis ?? fakeRedis(),
    llm: overrides?.llm ?? fakeLlm(),
    log: overrides?.log,
    now: overrides?.now ?? FIXED_NOW,
    sha256Hex: overrides?.sha256Hex ?? fakeSha256,
  };
}

function errorCode(result: AiProxyResult): string | undefined {
  const body = result.body as { error?: string };
  return body.error;
}

// ── Happy path ────────────────────────────────────────────────────────────

describe("handleAiProxyRequest — happy path", () => {
  it("returns 200 with the refinements and reads provider+model from env", async () => {
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(makeReq(), makeDeps({ llm }));

    expect(result.status).toBe(200);
    expect("refinements" in result.body).toBe(true);
    expect(llm.calls).toHaveLength(1);
    // Provider AND model come straight from env — no hard-coded model.
    expect(llm.calls[0].provider).toBe("openai");
    expect(llm.calls[0].model).toBe("test-model-x");
    expect(llm.calls[0].maxOutputTokens).toBeGreaterThan(0);
  });

  it("declares the sampled values untrusted in the system prompt and sends JSON user content", async () => {
    const llm = fakeLlm();
    await handleAiProxyRequest(makeReq(), makeDeps({ llm }));
    const { systemPrompt, userPrompt } = llm.calls[0];
    expect(systemPrompt.toLowerCase()).toContain("untrusted");
    expect(systemPrompt.toLowerCase()).toContain("json only");
    // The user prompt carries only names + bounded samples (no full rows).
    const parsed = JSON.parse(userPrompt) as AiRequest;
    expect(parsed.columns[0].columnName).toBe("Monster Name");
    expect(parsed.columns[0].samples).toContain("Swamp Wraith");
  });

  it("logs ONLY coarse metadata — never SampleValues", async () => {
    const logged: ProxyLogMeta[] = [];
    const log = (m: ProxyLogMeta) => logged.push(m);
    await handleAiProxyRequest(makeReq(), makeDeps({ log }));

    expect(logged).toHaveLength(1);
    const meta = logged[0];
    expect(meta.status).toBe(200);
    expect(meta.code).toBe("ok");
    expect(meta.columnCount).toBe(2);
    expect(meta.candidateCount).toBe(1);
    // No sample value may appear anywhere in the serialized log metadata.
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("Swamp Wraith");
    expect(serialized).not.toContain("Bog Golem");
    expect(serialized).not.toContain("Night Howler");
  });
});

// ── Method ──────────────────────────────────────────────────────────────────

describe("handleAiProxyRequest — method", () => {
  it("rejects non-POST with 405 and never calls the upstream", async () => {
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(
      makeReq({ method: "GET" }),
      makeDeps({ llm })
    );
    expect(result.status).toBe(405);
    expect(llm.calls).toHaveLength(0);
  });
});

// ── Missing env → fail closed, no upstream call ─────────────────────────────

describe("handleAiProxyRequest — missing env (fail closed)", () => {
  for (const missing of ["AI_PROVIDER", "AI_MODEL", "IP_HASH_SALT"] as const) {
    it(`returns 503 and never calls the upstream when ${missing} is missing`, async () => {
      const env = { ...GOOD_ENV, [missing]: undefined };
      const llm = fakeLlm();
      const redis = fakeRedis();
      const result = await handleAiProxyRequest(
        makeReq(),
        makeDeps({ env, llm, redis })
      );
      expect(result.status).toBe(503);
      expect(errorCode(result)).toBe("unavailable");
      expect(llm.calls).toHaveLength(0);
      // Fail-closed before counters too — env is checked first.
      expect(redis.calls).toHaveLength(0);
    });
  }
});

// ── Payload size ──────────────────────────────────────────────────────────

describe("handleAiProxyRequest — payload size", () => {
  it("rejects bodies larger than AI_PROXY_MAX_PAYLOAD_BYTES with 413", async () => {
    // Build a syntactically-irrelevant oversized body; the size check precedes parsing.
    const rawBody = "x".repeat(AI_PROXY_MAX_PAYLOAD_BYTES + 1);
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(
      makeReq({ rawBody }),
      makeDeps({ llm })
    );
    expect(result.status).toBe(413);
    expect(errorCode(result)).toBe("payload_too_large");
    expect(llm.calls).toHaveLength(0);
  });

  it("accepts a body exactly at the limit (boundary)", async () => {
    // Pad the valid request with an allowed-size filler is not possible (unknown
    // fields rejected); instead assert a body at the limit size made of the
    // valid JSON plus whitespace still parses and passes the size gate.
    const base = JSON.stringify(VALID_REQUEST);
    const pad = " ".repeat(AI_PROXY_MAX_PAYLOAD_BYTES - base.length);
    const rawBody = base + pad; // trailing whitespace is valid JSON
    expect(rawBody.length).toBe(AI_PROXY_MAX_PAYLOAD_BYTES);
    const result = await handleAiProxyRequest(
      makeReq({ rawBody }),
      makeDeps()
    );
    expect(result.status).toBe(200);
  });
});

// ── Schema rejection ────────────────────────────────────────────────────────

describe("handleAiProxyRequest — schema rejection (400)", () => {
  it("rejects malformed JSON", async () => {
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: "{ not json" }),
      makeDeps()
    );
    expect(result.status).toBe(400);
    expect(errorCode(result)).toBe("bad_request");
  });

  it("rejects an unknown top-level field", async () => {
    const body = { ...VALID_REQUEST, extra: 1 };
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(result.status).toBe(400);
  });

  it("rejects an unknown field inside a column", async () => {
    const body = {
      ...VALID_REQUEST,
      columns: [{ ...VALID_REQUEST.columns[0], sneaky: true }],
    };
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(result.status).toBe(400);
  });

  it("rejects more than AI_PROXY_MAX_COLUMNS columns", async () => {
    const columns = Array.from({ length: AI_PROXY_MAX_COLUMNS + 1 }, (_, i) => ({
      tableName: "t",
      columnName: `c${i}`,
      type: "string" as const,
      samples: ["v"],
    }));
    const body = { columns, candidates: [] };
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(result.status).toBe(400);
  });

  it("rejects more than AI_PROXY_MAX_CANDIDATES candidates", async () => {
    const candidates = Array.from(
      { length: AI_PROXY_MAX_CANDIDATES + 1 },
      (_, i) => ({
        id: `m${i}`,
        left: { tableName: "a", columnName: "x" },
        right: { tableName: "b", columnName: "y" },
        ruleConfidence: 0.6,
      })
    );
    const body = { columns: [], candidates };
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(result.status).toBe(400);
  });

  it("rejects more than AI_PROXY_MAX_SAMPLES_PER_COLUMN samples", async () => {
    const samples = Array.from(
      { length: AI_PROXY_MAX_SAMPLES_PER_COLUMN + 1 },
      (_, i) => `v${i}`
    );
    const body = {
      columns: [{ tableName: "t", columnName: "c", type: "string", samples }],
      candidates: [],
    };
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(result.status).toBe(400);
  });

  it("rejects a sample longer than 40 chars", async () => {
    const body = {
      columns: [
        {
          tableName: "t",
          columnName: "c",
          type: "string",
          samples: ["x".repeat(41)],
        },
      ],
      candidates: [],
    };
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(result.status).toBe(400);
  });

  it("rejects an invalid column type", async () => {
    const body = {
      columns: [
        { tableName: "t", columnName: "c", type: "wat", samples: ["v"] },
      ],
      candidates: [],
    };
    const result = await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps()
    );
    expect(result.status).toBe(400);
  });

  it("does not call the upstream on a schema rejection", async () => {
    const llm = fakeLlm();
    const body = { ...VALID_REQUEST, extra: 1 };
    await handleAiProxyRequest(
      makeReq({ rawBody: JSON.stringify(body) }),
      makeDeps({ llm })
    );
    expect(llm.calls).toHaveLength(0);
  });
});

// ── Origin courtesy check ───────────────────────────────────────────────────

describe("handleAiProxyRequest — origin courtesy check (403)", () => {
  const envWithAllowList: AiProxyEnv = {
    ...GOOD_ENV,
    ALLOWED_ORIGINS: "https://frankendata.example, https://alt.example",
  };

  it("allows an origin on the list", async () => {
    const result = await handleAiProxyRequest(
      makeReq({ origin: "https://frankendata.example" }),
      makeDeps({ env: envWithAllowList })
    );
    expect(result.status).toBe(200);
  });

  it("rejects an origin not on the list with 403", async () => {
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(
      makeReq({ origin: "https://evil.example" }),
      makeDeps({ env: envWithAllowList, llm })
    );
    expect(result.status).toBe(403);
    expect(errorCode(result)).toBe("forbidden_origin");
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects a missing origin when an allow-list is configured", async () => {
    const result = await handleAiProxyRequest(
      makeReq({ origin: undefined }),
      makeDeps({ env: envWithAllowList })
    );
    expect(result.status).toBe(403);
  });

  it("skips the check (allows) when no allow-list is configured", async () => {
    const result = await handleAiProxyRequest(
      makeReq({ origin: "https://anything.example" }),
      makeDeps()
    );
    expect(result.status).toBe(200);
  });
});

// ── Per-client rate limit ───────────────────────────────────────────────────

describe("handleAiProxyRequest — per-client limit (429)", () => {
  it("allows the request at the limit and rejects the one that exceeds it", async () => {
    // Prime the per-client counter so the next incr lands exactly at the limit.
    const atLimit = fakeRedis({ counts: { "rl:": AI_PROXY_PER_CLIENT_LIMIT - 1 } });
    const okResult = await handleAiProxyRequest(
      makeReq(),
      makeDeps({ redis: atLimit })
    );
    expect(okResult.status).toBe(200);

    const overLimit = fakeRedis({ counts: { "rl:": AI_PROXY_PER_CLIENT_LIMIT } });
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(
      makeReq(),
      makeDeps({ redis: overLimit, llm })
    );
    expect(result.status).toBe(429);
    expect(errorCode(result)).toBe("rate_limited");
    expect(llm.calls).toHaveLength(0);
  });
});

// ── Global daily cap ─────────────────────────────────────────────────────────

describe("handleAiProxyRequest — global daily cap (429 + cap marker)", () => {
  it("rejects with a cap marker when the global cap is exceeded", async () => {
    // Per-client counter is fresh; the GLOBAL cap counter is primed past its cap.
    const redis = fakeRedis({ counts: { "cap:": AI_PROXY_DAILY_REQUEST_CAP } });
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(
      makeReq(),
      makeDeps({ redis, llm })
    );
    expect(result.status).toBe(429);
    expect(errorCode(result)).toBe("daily_cap");
    expect((result.body as { cap?: true }).cap).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });
});

// ── Redis unreachable → fail closed, no upstream call ───────────────────────

describe("handleAiProxyRequest — Redis unreachable (fail closed)", () => {
  it("returns 503 and never calls the upstream when the per-client incr throws", async () => {
    const redis = fakeRedis({ throwOnCall: 1 });
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(
      makeReq(),
      makeDeps({ redis, llm })
    );
    expect(result.status).toBe(503);
    expect(errorCode(result)).toBe("unavailable");
    expect(llm.calls).toHaveLength(0);
  });

  it("returns 503 and never calls the upstream when the global-cap incr throws", async () => {
    const redis = fakeRedis({ throwOnCall: 2 });
    const llm = fakeLlm();
    const result = await handleAiProxyRequest(
      makeReq(),
      makeDeps({ redis, llm })
    );
    expect(result.status).toBe(503);
    expect(errorCode(result)).toBe("unavailable");
    expect(llm.calls).toHaveLength(0);
  });
});

// ── Upstream failure / malformed output → fail closed ───────────────────────

describe("handleAiProxyRequest — upstream failure (503)", () => {
  it("returns 503 when the upstream throws (after counters were spent)", async () => {
    const llm = fakeLlm({ throws: true });
    const result = await handleAiProxyRequest(makeReq(), makeDeps({ llm }));
    expect(result.status).toBe(503);
    expect(errorCode(result)).toBe("unavailable");
    expect(llm.calls).toHaveLength(1); // it WAS called, then failed
  });

  it("returns 503 when the upstream output is not valid refinements JSON", async () => {
    const llm = fakeLlm({ reply: "totally not json" });
    const result = await handleAiProxyRequest(makeReq(), makeDeps({ llm }));
    expect(result.status).toBe(503);
  });

  it("tolerates a ```json fenced response", async () => {
    const reply =
      '```json\n{"refinements":[{"id":"monsters.Monster Name~experiments.name","confidence":0.9,"reason":"ok"}]}\n```';
    const llm = fakeLlm({ reply });
    const result = await handleAiProxyRequest(makeReq(), makeDeps({ llm }));
    expect(result.status).toBe(200);
    expect("refinements" in result.body).toBe(true);
  });
});

// ── Client identity hashing ─────────────────────────────────────────────────

describe("handleAiProxyRequest — client identity", () => {
  it("keys the per-client counter on a salted hash of the IP, never the raw IP", async () => {
    const sha = vi.fn(fakeSha256);
    const redis = fakeRedis();
    await handleAiProxyRequest(
      makeReq({ clientIp: "198.51.100.9" }),
      makeDeps({ redis, sha256Hex: sha })
    );
    // The salt is mixed into the hash input.
    expect(sha).toHaveBeenCalledWith("198.51.100.9pepper");
    // The per-client Redis key is the HASH, not the raw IP.
    const clientKey = redis.calls.find((k) => k.startsWith("rl:"));
    expect(clientKey).toBeDefined();
    expect(clientKey).not.toContain("198.51.100.9");
    // The key embeds the opaque hash the stub produced, not the raw IP.
    expect(clientKey).toContain(await fakeSha256("198.51.100.9pepper"));
  });
});
