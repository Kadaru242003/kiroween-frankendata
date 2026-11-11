/**
 * Vercel serverless function for the FrankenData SqlProxy (Feature 3, task 9).
 *
 * The `/api/sql` sibling of `api/ai.ts`: a THIN host entrypoint that decodes the
 * Node `(req, res)` request, builds the real {@link RedisClient} and
 * {@link LlmClient} from the SAME `process.env` configuration as `api/ai.ts`
 * (shared helpers in `api/_shared.ts`), and delegates every decision to the
 * framework-agnostic {@link handleSqlProxyRequest} in `src/core/chat/sql-proxy.ts`.
 *
 * It reuses the same provider/model/key/Upstash/salt/origin env and the same
 * payload byte cap. The SqlProxy counts per-client requests under its own
 * hourly key prefix (`rlsql:`) but increments the SAME global daily-cap key as
 * `/api/ai`, so the daily spending cap is shared across both proxies.
 *
 * Secrets: the LLM API key is read from `process.env` ONLY here, lives
 * server-side, and is never returned to the client. Fail-closed: missing
 * Upstash/env makes the injected clients reject, and the core handler returns
 * "unavailable" without calling the LLM.
 */

import {
  handleSqlProxyRequest,
  AI_PROXY_MAX_PAYLOAD_BYTES,
} from "../src/core/chat/sql-proxy.js";
import type {
  AiProxyEnv,
  LlmClient,
  RedisClient,
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
 * Vercel Node.js runtime entrypoint for `/api/sql`. Streams the body with a
 * hard byte cap, adapts it to {@link handleSqlProxyRequest}, and writes the
 * `{ status, body }` result back via `res`.
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

  const redis: RedisClient = restUrl && restToken
    ? makeUpstashRedis(restUrl, restToken)
    : { incrWithTtl: async () => { throw new Error("Upstash not configured"); } };

  const llm: LlmClient = apiKey
    ? makeLlmClient(apiKey, llmBaseUrl)
    : { complete: async () => { throw new Error("LLM key not configured"); } };

  const read = await readBodyCapped(req, AI_PROXY_MAX_PAYLOAD_BYTES);
  if (read.overLimit) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "payload_too_large" }));
    return;
  }

  const result = await handleSqlProxyRequest(
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
