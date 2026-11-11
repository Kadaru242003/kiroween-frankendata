/**
 * SqlProvider implementations for "Ask the Lab" (Feature 3, task 5).
 *
 * The {@link SqlProvider} interface (types.ts) is the seam through which the
 * {@link import("./ask-controller").createAskController} optionally turns a
 * question + {@link SchemaSummary} into `{ sql, explanation, chart? }`. This
 * task ships the TEST implementation only; the production
 * {@link ProxySqlProvider} that posts to `/api/sql` is task 9 (Group E), so
 * nothing here touches the network.
 *
 * {@link createFakeSqlProvider} mirrors Feature 2's `createFakeAiProvider`: it
 * records every request and, per its behavior, resolves with a canned response,
 * delegates to a function, or throws — so the controller's success, repair, and
 * failure/fallback paths are all exercised deterministically with no network
 * (Req 10.8, 10.10).
 */

import type { SqlProvider, SqlRequest, SqlResponse } from "./types.js";
import { AI_REQUEST_TIMEOUT_MS } from "./types.js";

/** The same-origin route the production SqlProxy is deployed at (task 9). */
export const SQL_PROXY_ENDPOINT = "/api/sql";

/** Options for {@link createProxySqlProvider}. */
export interface ProxySqlProviderOptions {
  /** Proxy endpoint. Defaults to {@link SQL_PROXY_ENDPOINT}. */
  endpoint?: string;
  /** Request timeout in ms. Defaults to {@link AI_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** `fetch` implementation. Defaults to the global `fetch` (injectable for tests). */
  fetchFn?: typeof fetch;
}

/**
 * Create the production {@link SqlProvider} that talks to the serverless
 * `/api/sql` proxy. `ask` POSTs the {@link SqlRequest} as JSON, aborts after the
 * timeout, and resolves with the parsed body ONLY on a `200`. Every other
 * outcome — non-200 status, network error, timeout (abort), or a body that is
 * not valid JSON — rejects, so the {@link import("./ask-controller").AskController}
 * maps it to `ai-unavailable`/`error` (Req 3.6). The provider never holds an
 * API key — the key lives server-side in the proxy. Mirrors Feature 2's
 * `createProxyAiProvider`.
 */
export function createProxySqlProvider(
  options: ProxySqlProviderOptions = {}
): SqlProvider {
  const endpoint = options.endpoint ?? SQL_PROXY_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  async function ask(input: SqlRequest): Promise<SqlResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      // Any non-200 (429/503/413/403/5xx/…) is a failure the controller maps to
      // ai-unavailable (429/503-like) or a friendly error. We surface the status
      // in the message so the controller's heuristic can classify it.
      if (response.status !== 200) {
        throw new Error(`SQL proxy returned status ${response.status}`);
      }
      return (await response.json()) as SqlResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  return { ask };
}

/** A behavior for {@link FakeSqlProvider} to drive a particular test path. */
export type FakeSqlBehavior =
  | { kind: "respond"; response: SqlResponse }
  | { kind: "throw"; error?: unknown }
  | { kind: "fn"; fn: (req: SqlRequest) => Promise<SqlResponse> | SqlResponse };

export interface FakeSqlProviderOptions {
  /** What the fake does on `ask`. Defaults to throwing (no canned default SQL). */
  behavior?: FakeSqlBehavior;
}

/** A test {@link SqlProvider} that records its calls and never hits the network. */
export interface FakeSqlProvider extends SqlProvider {
  /** Every request passed to {@link SqlProvider.ask}, in call order. */
  readonly calls: readonly SqlRequest[];
}

export function createFakeSqlProvider(
  options: FakeSqlProviderOptions = {}
): FakeSqlProvider {
  const behavior: FakeSqlBehavior =
    options.behavior ?? { kind: "throw", error: new Error("FakeSqlProvider: no behavior") };
  const calls: SqlRequest[] = [];

  async function ask(req: SqlRequest): Promise<SqlResponse> {
    calls.push(req);
    switch (behavior.kind) {
      case "respond":
        return behavior.response;
      case "throw":
        throw behavior.error ?? new Error("FakeSqlProvider failure");
      case "fn":
        return behavior.fn(req);
    }
  }

  return {
    ask,
    get calls() {
      return calls;
    },
  };
}
