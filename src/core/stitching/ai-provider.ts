/**
 * AI provider implementations for the stitching stage (Feature 2, task 19).
 *
 * The {@link AiProvider} interface (types.ts) is the single seam through which
 * {@link import("./stitch-controller").createStitchController} optionally
 * refines deterministic match scores. This module ships two implementations:
 *
 *   - {@link ProxyAiProvider} — the production provider. It POSTs the budgeted
 *     {@link AiRequest} to the same-origin serverless proxy at `/api/ai`
 *     (built later, task 21) over `fetch`, aborting after
 *     {@link AI_REQUEST_TIMEOUT_MS}. Any non-200, timeout, network error, or
 *     non-JSON body throws, and the controller's try/catch turns that into the
 *     guaranteed rules fallback (`aiUsed = false`). The provider never holds an
 *     API key — the key lives server-side in the proxy (Req 6.3).
 *   - {@link FakeAiProvider} — the test provider. It never touches the network
 *     (Req 6.7, 10.7): it returns a canned {@link AiResponse}, or invokes a
 *     caller-supplied function, or throws, so tests can exercise the success,
 *     partial-validity, and failure/fallback paths deterministically.
 *
 * This module is framework-agnostic (no React, no DOM). `ProxyAiProvider` is
 * unit-tested only by mocking `globalThis.fetch`; no test makes a real network
 * call.
 */

import type { AiProvider, AiRequest, AiResponse } from "./types";
import { AI_REQUEST_TIMEOUT_MS } from "./types";

/** The same-origin route the production proxy is deployed at (task 21). */
export const AI_PROXY_ENDPOINT = "/api/ai";

/** Options for {@link createProxyAiProvider}. */
export interface ProxyAiProviderOptions {
  /** Proxy endpoint. Defaults to {@link AI_PROXY_ENDPOINT}. */
  endpoint?: string;
  /** Request timeout in ms. Defaults to {@link AI_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * `fetch` implementation. Defaults to the global `fetch`. Injectable so unit
   * tests can mock it without touching the real network.
   */
  fetchFn?: typeof fetch;
}

/**
 * Create the production {@link AiProvider} that talks to the serverless proxy.
 *
 * `refine` POSTs the request as JSON, aborts after the timeout, and resolves
 * with the parsed body ONLY on a `200`. Every other outcome — non-200 status,
 * network error, timeout (abort), or a body that is not valid JSON — rejects.
 * The controller catches the rejection and falls back to the rules result, so
 * callers never see an AI error (Req 6.5). The returned body is NOT validated
 * here; shape/eligibility/bounding validation happens in
 * {@link import("./ai-validation").validateAiResponse} on the controller side.
 */
export function createProxyAiProvider(
  options: ProxyAiProviderOptions = {}
): AiProvider {
  const endpoint = options.endpoint ?? AI_PROXY_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  async function refine(input: AiRequest): Promise<AiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      // Any non-200 (429/503/413/403/5xx/…) is a failure → rules fallback.
      if (response.status !== 200) {
        throw new Error(`AI proxy returned status ${response.status}`);
      }
      // A non-JSON body throws here and is likewise treated as a failure.
      return (await response.json()) as AiResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  return { refine };
}

/** A behavior for {@link FakeAiProvider} to drive a particular test path. */
export type FakeAiBehavior =
  | { kind: "respond"; response: AiResponse }
  | { kind: "throw"; error?: unknown }
  | { kind: "fn"; fn: (input: AiRequest) => Promise<AiResponse> | AiResponse };

/** Options for {@link createFakeAiProvider}. */
export interface FakeAiProviderOptions {
  /**
   * What the fake does when `refine` is called. Defaults to resolving with an
   * empty refinement list (a valid no-op response).
   */
  behavior?: FakeAiBehavior;
}

/**
 * Create a test {@link AiProvider} that NEVER touches the network (Req 6.7,
 * 10.7). It records every request it receives (for payload-budgeting
 * assertions) and, per its {@link FakeAiBehavior}:
 *   - `respond`  — resolves with a canned {@link AiResponse};
 *   - `throw`    — rejects (to exercise the controller's rules fallback / a
 *                  timeout-like failure);
 *   - `fn`       — delegates to a caller-supplied function.
 */
export interface FakeAiProvider extends AiProvider {
  /** Every request passed to {@link AiProvider.refine}, in call order. */
  readonly calls: readonly AiRequest[];
}

export function createFakeAiProvider(
  options: FakeAiProviderOptions = {}
): FakeAiProvider {
  const behavior: FakeAiBehavior =
    options.behavior ?? { kind: "respond", response: { refinements: [] } };
  const calls: AiRequest[] = [];

  async function refine(input: AiRequest): Promise<AiResponse> {
    calls.push(input);
    switch (behavior.kind) {
      case "respond":
        return behavior.response;
      case "throw":
        throw behavior.error ?? new Error("FakeAiProvider failure");
      case "fn":
        return behavior.fn(input);
    }
  }

  return {
    refine,
    get calls() {
      return calls;
    },
  };
}
