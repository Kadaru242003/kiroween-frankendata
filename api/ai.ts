/**
 * Vercel serverless function for the FrankenData AiProxy (Feature 2, task 21).
 *
 * This file is a THIN host entrypoint: it decodes the incoming Node `(req, res)`
 * request, constructs the real {@link RedisClient} and {@link LlmClient}, reads
 * ALL configuration from `process.env` at runtime, and delegates every decision
 * to the framework-agnostic {@link handleAiProxyRequest} in
 * `src/core/stitching/ai-proxy.ts`.
 *
 * The Node adapter plumbing (body streaming with a hard byte cap, the Upstash
 * REST Redis client, the OpenAI-compatible LLM client, and the header helpers)
 * is SHARED with `api/sql.ts` via `api/_shared.ts` (Feature 3, task 8). That
 * extraction is a pure refactor — this entrypoint's observable behavior is
 * unchanged.
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
 */

import {
  handleAiProxyRequest,
  AI_PROXY_MAX_PAYLOAD_BYTES,
  type AiProxyEnv,
  type LlmClient,
  type RedisClient,
} from "../src/core/stitching/ai-proxy.js";
import {
  clientIpFrom,
  header,
  makeLlmClient,
  makeUpstashRedis,
  readBodyCapped,
  type NodeLikeRequest,
  type NodeLikeResponse,
} from "./_shared.js";

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
