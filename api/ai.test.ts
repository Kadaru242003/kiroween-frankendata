/**
 * Adapter tests for the Vercel Node.js entrypoint `api/ai.ts` (bug fix: the
 * production runtime invokes the default export as `(req, res)` with a
 * Node-style readable `req` and a `ServerResponse`-like `res`, NOT a web
 * `Request` — so the old `req.text()` threw `TypeError: req.text is not a
 * function`).
 *
 * These exercise the thin adapter with a Node-style fake request (a `Readable`
 * stream carrying `method` + `headers`) and a fake response that captures
 * status/headers/body. The framework-agnostic core (`ai-proxy.ts`) is unchanged
 * and already unit-tested; here we only assert the adapter correctly streams
 * the body (with its hard byte cap) and writes the `{ status, body }` back.
 *
 * No real Redis/LLM/network: with no Upstash/env configured the core fails
 * closed to 503, which is fine — we assert the adapter never THROWS and emits a
 * valid JSON response with the right status for each shape.
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import handler from "./ai";
import { AI_PROXY_MAX_PAYLOAD_BYTES } from "../src/core/stitching/ai-proxy.js";

/** A Node IncomingMessage-like request: a Readable stream + method + headers. */
function fakeRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Readable & {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
} {
  const stream = Readable.from(
    options.body === undefined ? [] : [Buffer.from(options.body, "utf8")]
  ) as Readable & {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
  };
  stream.method = options.method;
  stream.headers = options.headers ?? {};
  return stream;
}

/** A ServerResponse-like capture. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      this.body = body;
      this.ended = true;
    },
  };
}

/** Parse the captured JSON body. */
function parseBody(res: ReturnType<typeof fakeResponse>): Record<string, unknown> {
  expect(res.ended).toBe(true);
  expect(res.headers["content-type"]).toBe("application/json");
  return JSON.parse(res.body ?? "null") as Record<string, unknown>;
}

describe("api/ai.ts Node (req, res) adapter", () => {
  // Ensure no real provider/Redis is configured → the core fails closed. We do
  // not set any secret; we just make sure none leak in from the environment.
  const SERVER_KEYS = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "OPENAI_API_KEY",
    "AI_API_KEY",
    "AI_PROVIDER",
    "AI_MODEL",
    "IP_HASH_SALT",
    "ALLOWED_ORIGINS",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of SERVER_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of SERVER_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("handles a valid POST without throwing and writes a JSON response", async () => {
    const req = fakeRequest({
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      body: JSON.stringify({ columns: [], candidates: [] }),
    });
    const res = fakeResponse();
    await expect(handler(req, res)).resolves.toBeUndefined();
    // No Redis/env configured → fail-closed 503 (never calls a provider).
    expect(res.statusCode).toBe(503);
    expect(parseBody(res).error).toBe("unavailable");
  });

  it("returns 400 for an empty-object body (schema violation)", async () => {
    // The core checks required (non-secret) env BEFORE the schema, so set the
    // provider/model/salt config (placeholders, NOT secrets) so `{}` reaches
    // and fails the schema check (400) rather than the earlier env gate (503).
    // Redis/LLM are still absent, but the schema check (step 4) runs before
    // any Redis counter (step 6), so no provider is ever contacted.
    process.env.AI_PROVIDER = "openai";
    process.env.AI_MODEL = "test-model";
    process.env.IP_HASH_SALT = "test-salt-not-a-secret";
    const req = fakeRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = fakeResponse();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe("bad_request");
  });

  it("returns 413 for an oversized body (adapter byte cap, never buffers it all)", async () => {
    // One byte over the limit; the adapter must stop reading and return 413.
    const huge = "x".repeat(AI_PROXY_MAX_PAYLOAD_BYTES + 1);
    const req = fakeRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    const res = fakeResponse();
    await handler(req, res);
    expect(res.statusCode).toBe(413);
    expect(parseBody(res).error).toBe("payload_too_large");
  });

  it("returns 405 for a non-POST method (proxy method error)", async () => {
    const req = fakeRequest({
      method: "GET",
      headers: {},
    });
    const res = fakeResponse();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(parseBody(res).error).toBe("method_not_allowed");
  });
});
