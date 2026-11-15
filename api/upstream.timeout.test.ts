/**
 * security-hardening, commit C: every upstream call (Upstash REST and the LLM)
 * has a 10 second timeout, and a timeout fails closed with 503 and no LLM call.
 *
 * `fetch` is stubbed, so nothing here touches the network. The stub never
 * answers on its own and rejects only when the request's AbortSignal fires, so
 * these tests pass only if the code really aborts. Timers are faked.
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aiHandler from "./ai";
import sqlHandler from "./sql";
import { UPSTREAM_TIMEOUT_MS, makeLlmClient, makeUpstashRedis } from "./_shared";

const UPSTASH = "https://redis.example.invalid";
const LLM_BASE = "https://llm.example.invalid/v1";

const KEYS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "OPENAI_API_KEY",
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_PROVIDER",
  "AI_MODEL",
  "IP_HASH_SALT",
  "ALLOWED_ORIGINS",
];
const saved: Record<string, string | undefined> = {};

type Call = { url: string; signal: AbortSignal | undefined };
let calls: Call[];

/** A fetch that answers Upstash `incr` with 1 and hangs on everything else it is told to. */
function stubFetch(hang: "upstash" | "llm") {
  calls = [];
  vi.stubGlobal(
    "fetch",
    (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, signal: init?.signal ?? undefined });
      const isUpstash = u.startsWith(UPSTASH);
      if (isUpstash && hang !== "upstash") {
        return Promise.resolve(new Response(JSON.stringify({ result: 1 }), { status: 200 }));
      }
      // Hang until aborted.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
  );
}

function fakeRequest(body: string) {
  const stream = Readable.from([Buffer.from(body, "utf8")]) as Readable & {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
  };
  stream.method = "POST";
  stream.headers = { "content-type": "application/json" };
  return stream;
}

function fakeResponse() {
  return {
    statusCode: 0,
    body: undefined as string | undefined,
    ended: false,
    setHeader() {},
    end(body?: string) {
      this.body = body;
      this.ended = true;
    },
  };
}

/** Advance fake time until the handler has answered (bounded). */
async function runUntilEnded(res: { ended: boolean }): Promise<void> {
  for (let i = 0; i < 40 && !res.ended; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.UPSTASH_REDIS_REST_URL = UPSTASH;
  process.env.UPSTASH_REDIS_REST_TOKEN = "placeholder-token";
  process.env.OPENAI_API_KEY = "placeholder-key";
  process.env.AI_BASE_URL = LLM_BASE;
  process.env.AI_PROVIDER = "openai";
  process.env.AI_MODEL = "test-model";
  process.env.IP_HASH_SALT = "placeholder-salt";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const SQL_BODY = JSON.stringify({ question: "q", schema: { tables: [] } });
const AI_BODY = JSON.stringify({ columns: [], candidates: [] });

describe("upstream timeout", () => {
  it("is 10 seconds", () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(10_000);
  });

  it.each([
    ["/api/sql", sqlHandler, SQL_BODY],
    ["/api/ai", aiHandler, AI_BODY],
  ])("%s returns 503 when Upstash hangs, and never calls the LLM", async (_name, handler, body) => {
    stubFetch("upstash");
    const res = fakeResponse();
    void handler(fakeRequest(body), res);
    await runUntilEnded(res);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body ?? "{}").error).toBe("unavailable");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
    expect(calls.some((c) => c.url.startsWith(LLM_BASE))).toBe(false);
  });

  it.each([
    ["/api/sql", sqlHandler, SQL_BODY],
    ["/api/ai", aiHandler, AI_BODY],
  ])("%s returns 503 when the LLM hangs", async (_name, handler, body) => {
    stubFetch("llm");
    const res = fakeResponse();
    void handler(fakeRequest(body), res);
    await runUntilEnded(res);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body ?? "{}").error).toBe("unavailable");
    const llmCall = calls.find((c) => c.url.startsWith(LLM_BASE));
    expect(llmCall).toBeDefined();
    expect(llmCall?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("upstream clients", () => {
  it("abort a request that outlives the timeout and reject", async () => {
    const hang = (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const redis = makeUpstashRedis(UPSTASH, "t", { timeoutMs: 50, fetchFn: hang as typeof fetch });
    const llm = makeLlmClient("k", LLM_BASE, { timeoutMs: 50, fetchFn: hang as typeof fetch });
    const a = expect(redis.incrWithTtl("k", 60)).rejects.toThrow();
    const b = expect(
      llm.complete({ provider: "openai", model: "m", systemPrompt: "s", userPrompt: "u", maxOutputTokens: 5 })
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60);
    await a;
    await b;
  });

  it("also time out while reading the response body", async () => {
    const slowBody = (_url: string | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_res, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      } as unknown as Response);
    const redis = makeUpstashRedis(UPSTASH, "t", { timeoutMs: 50, fetchFn: slowBody as typeof fetch });
    const p = expect(redis.incrWithTtl("k", 60)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60);
    await p;
  });

  it("still return a normal reply before the timeout", async () => {
    const ok = (url: string | URL) =>
      Promise.resolve(
        new Response(
          String(url).includes("/incr/")
            ? JSON.stringify({ result: 1 })
            : JSON.stringify({ result: 1 }),
          { status: 200 }
        )
      );
    const redis = makeUpstashRedis(UPSTASH, "t", { timeoutMs: 50, fetchFn: ok as typeof fetch });
    await expect(redis.incrWithTtl("k", 60)).resolves.toBe(1);
    const llm = makeLlmClient("k", LLM_BASE, {
      timeoutMs: 50,
      fetchFn: (() =>
        Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }))) as typeof fetch,
    });
    await expect(
      llm.complete({ provider: "openai", model: "m", systemPrompt: "s", userPrompt: "u", maxOutputTokens: 5 })
    ).resolves.toBe("hi");
  });
});
