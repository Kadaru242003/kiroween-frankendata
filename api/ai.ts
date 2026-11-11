/**
 * Vercel serverless function for the FrankenData AiProxy (Feature 2, task 21).
 *
 * This file is the ONLY place that touches the host runtime, the real Upstash
 * REST API, the real LLM provider `fetch`, and `process.env`. It is intentionally
 * thin: it decodes the incoming request, constructs the real {@link RedisClient}
 * and {@link LlmClient}, reads ALL configuration (provider, model, API key,
 * Upstash credentials, IP-hash salt, allowed origins) from `process.env` at
 * runtime, and delegates every decision to the framework-agnostic
 * {@link handleAiProxyRequest} in `src/core/stitching/ai-proxy.ts` (unit-tested
 * with mocked Redis + mocked upstream).
 *
 * Secrets:
 *   - The LLM API key is read from `process.env` ONLY here, lives server-side,
 *     and is never returned to the client. No secret value is ever logged.
 *   - Provider AND model come from env (`AI_PROVIDER`, `AI_MODEL`); there is no
 *     hard-coded model name.
 *
 * Fail-closed: if the Upstash credentials or required env are missing, the
 * injected clients reject, and the core handler returns the "unavailable"
 * status without ever calling the LLM upstream.
 *
 * Note: `.env.example`, `vercel.json` routing, and `DEPLOY.md` are task 22, not
 * this file.
 */

import {
  handleAiProxyRequest,
  AI_PROXY_MAX_PAYLOAD_BYTES,
  type AiProxyEnv,
  type LlmClient,
  type LlmCompletionInput,
  type RedisClient,
} from "../src/core/stitching/ai-proxy.js";

// Deliberately structural Node-style request/response typings so this file
// does not depend on a specific `@vercel/node` version being installed.
// Vercel's Node.js runtime invokes the default export as `(req, res)` where
// `req` is a Node IncomingMessage-like readable stream (NOT a web `Request`,
// so it has no `.text()`), and `res` is a ServerResponse-like writable.
interface NodeLikeRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  // Readable-stream event surface — enough to accumulate the raw body.
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  // Optional: lets us stop reading an oversized stream early.
  destroy?(error?: Error): void;
}

interface NodeLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/** Read a single request header, coalescing the array form to its first value. */
function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw ?? undefined;
}

/** Extract a best-effort client IP from the standard proxy headers. */
function clientIpFrom(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const xff = header(headers, "x-forwarded-for");
  if (xff) {
    // First entry is the original client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return header(headers, "x-real-ip");
}

/**
 * Read the raw request body from the Node stream into a UTF-8 string, with a
 * HARD byte cap. As soon as the accumulated bytes exceed `maxBytes` we stop
 * reading, destroy the stream, and signal `overLimit` — so a malicious or
 * buggy client can never make us buffer unbounded input. The cap equals the
 * proxy's payload limit; the core handler also re-checks the exact byte
 * length, so behavior (413) is identical whether the body is slightly or
 * massively over the limit.
 */
function readBodyCapped(
  req: NodeLikeRequest,
  maxBytes: number,
): Promise<{ overLimit: true } | { overLimit: false; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (
      value: { overLimit: true } | { overLimit: false; body: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buf.length;
      if (total > maxBytes) {
        // Stop buffering immediately and tear down the stream.
        try {
          req.destroy?.();
        } catch {
          /* best-effort */
        }
        finish({ overLimit: true });
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      finish({ overLimit: false, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * Build the Upstash REST Redis client. Uses the REST API (`/incr/<key>` then
 * `/expire/<key>/<ttl>/NX`) so there is no TCP driver dependency. Any non-OK
 * response or network error rejects, which the core handler turns into a
 * fail-closed "unavailable" (no upstream call).
 */
function makeUpstashRedis(restUrl: string, restToken: string): RedisClient {
  async function cmd(path: string): Promise<unknown> {
    const res = await fetch(`${restUrl}/${path}`, {
      headers: { Authorization: `Bearer ${restToken}` },
    });
    if (!res.ok) {
      throw new Error(`Upstash REST error ${res.status}`);
    }
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(json.error);
    return json.result;
  }

  return {
    async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
      const encoded = encodeURIComponent(key);
      const result = await cmd(`incr/${encoded}`);
      const count = Number(result);
      if (!Number.isFinite(count)) {
        throw new Error("Upstash INCR returned a non-numeric result");
      }
      // Only the first creation needs a TTL; `EXPIRE ... NX` is a no-op after.
      if (count === 1) {
        await cmd(`expire/${encoded}/${ttlSeconds}/NX`);
      }
      return count;
    },
  };
}

/**
 * Build the LLM client for the configured provider. The API key is read here
 * from env and never leaves the server. Currently wires the OpenAI-compatible
 * Chat Completions shape (used by OpenAI and many compatible providers); the
 * MODEL is passed through from env — never hard-coded.
 */
function makeLlmClient(apiKey: string, baseUrl: string): LlmClient {
  return {
    async complete(input: LlmCompletionInput): Promise<string> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: input.maxOutputTokens,
          temperature: 0,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`LLM upstream error ${res.status}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM upstream returned no content");
      }
      return content;
    },
  };
}

/**
 * Vercel Node.js runtime entrypoint. Invoked as `(req, res)` with a Node
 * IncomingMessage-like `req` (a readable stream — NO web `Request`/`.text()`)
 * and a ServerResponse-like `res`. We stream the body with a hard byte cap,
 * adapt it to the framework-agnostic {@link handleAiProxyRequest} shape, and
 * write the `{ status, body }` result back via `res`.
 */
export default async function handler(
  req: NodeLikeRequest,
  res: NodeLikeResponse,
): Promise<void> {
  const env: AiProxyEnv = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    IP_HASH_SALT: process.env.IP_HASH_SALT,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  };

  const restUrl = process.env.UPSTASH_REDIS_REST_URL ?? "";
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY ?? "";
  const llmBaseUrl = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";

  // If the Upstash credentials or the API key are missing, the clients reject
  // on use and the core handler fails closed (503, no upstream call). We never
  // branch on the key value here beyond presence, and never log it.
  const redis: RedisClient = restUrl && restToken
    ? makeUpstashRedis(restUrl, restToken)
    : { incrWithTtl: async () => { throw new Error("Upstash not configured"); } };

  const llm: LlmClient = apiKey
    ? makeLlmClient(apiKey, llmBaseUrl)
    : { complete: async () => { throw new Error("LLM key not configured"); } };

  // Stream the body with a hard cap = the proxy payload limit. If the client
  // sends more, we stop reading and return 413 WITHOUT buffering it all or
  // calling the core handler — identical status to the core's own size check.
  const read = await readBodyCapped(req, AI_PROXY_MAX_PAYLOAD_BYTES);
  if (read.overLimit) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "payload_too_large" }));
    return;
  }

  const result = await handleAiProxyRequest(
    {
      method: req.method ?? "GET",
      rawBody: read.body,
      origin: header(req.headers, "origin"),
      clientIp: clientIpFrom(req.headers),
    },
    { env, redis, llm }
  );

  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.body));
}
