/**
 * Shared Node.js adapter helpers for the FrankenData serverless functions
 * (Feature 3, task 8).
 *
 * `api/ai.ts` and `api/sql.ts` are both thin Vercel Node.js entrypoints invoked
 * as `(req, res)` with a Node IncomingMessage-like readable `req` (NOT a web
 * `Request`, so no `.text()`) and a ServerResponse-like `res`. The body-reading
 * (with a hard byte cap), the Upstash REST Redis client, the OpenAI-compatible
 * LLM client, and the header helpers are IDENTICAL across both, so they live
 * here and are imported by each entrypoint. Extracting them is a PURE refactor:
 * `api/ai.ts`'s observable behavior is unchanged, so its adapter tests and the
 * `src/core/stitching` proxy tests pass unchanged and `npm run check:api` still
 * passes.
 *
 * This file is plain Node ESM (explicit `.js` import extensions elsewhere in
 * the graph) and the ONLY things it touches are the Node stream, `fetch`, and
 * `Buffer`/`TextEncoder` — never `process.env` (the entrypoints read env and
 * pass the clients in).
 */

import type {
  RedisClient,
  LlmClient,
  LlmCompletionInput,
} from "../src/core/stitching/ai-proxy.js";

// Deliberately structural Node-style request/response typings so these files do
// not depend on a specific `@vercel/node` version being installed.
export interface NodeLikeRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  destroy?(error?: Error): void;
}

export interface NodeLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/** Read a single request header, coalescing the array form to its first value. */
export function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw ?? undefined;
}

/** Extract a best-effort client IP from the standard proxy headers. */
export function clientIpFrom(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const xff = header(headers, "x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return header(headers, "x-real-ip");
}

/**
 * Read the raw request body from the Node stream into a UTF-8 string, with a
 * HARD byte cap. As soon as the accumulated bytes exceed `maxBytes` we stop
 * reading, destroy the stream, and signal `overLimit` — so a malicious or buggy
 * client can never make us buffer unbounded input.
 */
export function readBodyCapped(
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
 * `/expire/<key>/<ttl>/NX`). Any non-OK response or network error rejects,
 * which the core handlers turn into a fail-closed "unavailable" (no upstream).
 */
export function makeUpstashRedis(restUrl: string, restToken: string): RedisClient {
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
      if (count === 1) {
        await cmd(`expire/${encoded}/${ttlSeconds}/NX`);
      }
      return count;
    },
  };
}

/**
 * Build the LLM client for the configured provider. The API key is read by the
 * caller from env and never leaves the server. Wires the OpenAI-compatible Chat
 * Completions shape; the MODEL is passed through from env — never hard-coded.
 */
export function makeLlmClient(apiKey: string, baseUrl: string): LlmClient {
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
