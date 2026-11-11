/**
 * Adapter tests for the Vercel Node.js entrypoint `api/sql.ts` (Feature 3, task
 * 9), modeled on `api/ai.test.ts`.
 *
 * The production runtime invokes the default export as `(req, res)` with a
 * Node-style readable `req` and a `ServerResponse`-like `res`. These exercise
 * the thin adapter (which shares the Node plumbing via `api/_shared.ts`) with a
 * fake request/response and assert it streams the body (with its hard byte cap)
 * and writes the `{ status, body }` result without throwing. The core
 * (`sql-proxy.ts`) is unit-tested separately; here, with no Upstash/env
 * configured, the core fails closed to 503 (or 400 on a schema violation), so
 * no provider is ever contacted and no network call is made.
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import handler from "./sql";
import { AI_PROXY_MAX_PAYLOAD_BYTES } from "../src/core/chat/sql-proxy.js";

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

function parseBody(res: ReturnType<typeof fakeResponse>): Record<string, unknown> {
  expect(res.ended).toBe(true);
  expect(res.headers["content-type"]).toBe("application/json");
  return JSON.parse(res.body ?? "null") as Record<string, unknown>;
}

describe("api/sql.ts Node (req, res) adapter", () => {
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
      body: JSON.stringify({ question: "q", schema: { tables: [] } }),
    });
    const res = fakeResponse();
    await expect(handler(req, res)).resolves.toBeUndefined();
    // No Redis/env configured → fail-closed 503 (never calls a provider).
    expect(res.statusCode).toBe(503);
    expect(parseBody(res).error).toBe("unavailable");
  });

  it("returns 400 for an empty-object body (schema violation)", async () => {
    // Env check precedes the schema check, so set provider/model/salt
    // (placeholders, NOT secrets) so `{}` reaches and fails the schema (400).
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
    const req = fakeRequest({ method: "GET", headers: {} });
    const res = fakeResponse();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(parseBody(res).error).toBe("method_not_allowed");
  });
});
