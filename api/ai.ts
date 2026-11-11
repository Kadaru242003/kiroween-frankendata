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
  type AiProxyEnv,
  type LlmClient,
  type LlmCompletionInput,
  type RedisClient,
} from "../src/core/stitching/ai-proxy.js";

// A deliberately structural Request/Response typing so this file does not
// depend on a specific `@vercel/node` version being installed. Vercel passes a
// Fetch-style `Request` to functions that export a default handler; we read the
// pieces the core handler needs and return a standard `Response`.
interface FetchLikeRequest {
  method: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Extract a best-effort client IP from the standard proxy headers. */
function clientIpFrom(headers: { get(name: string): string | null }): string | undefined {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    // First entry is the original client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? undefined;
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

export default async function handler(req: FetchLikeRequest): Promise<Response> {
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

  const rawBody = await req.text();
  const result = await handleAiProxyRequest(
    {
      method: req.method,
      rawBody,
      origin: req.headers.get("origin") ?? undefined,
      clientIp: clientIpFrom(req.headers),
    },
    { env, redis, llm }
  );

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}
