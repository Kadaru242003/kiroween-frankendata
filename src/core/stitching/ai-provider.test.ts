/**
 * Unit tests for the AI providers (Feature 2, task 19).
 *
 * `ProxyAiProvider` is tested ONLY by mocking `fetch` — no real network call is
 * ever made. Covers: success (200 → parsed body), non-200 rejection, non-JSON
 * body rejection, network-error rejection, and timeout/abort rejection.
 *
 * `FakeAiProvider` is tested for its respond/throw/fn behaviors and that it
 * records every request (for payload assertions) without touching the network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createFakeAiProvider,
  createProxyAiProvider,
} from "./ai-provider";
import type { AiRequest, AiResponse } from "./types";

const REQUEST: AiRequest = {
  columns: [
    { tableName: "a", columnName: "x", type: "string", samples: ["v"] },
  ],
  candidates: [
    {
      id: "m1",
      left: { tableName: "a", columnName: "x" },
      right: { tableName: "b", columnName: "y" },
      ruleConfidence: 0.8,
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("ProxyAiProvider", () => {
  it("POSTs to /api/ai and resolves with the parsed body on 200", async () => {
    const response: AiResponse = {
      refinements: [{ id: "m1", confidence: 0.9, reason: "ok" }],
    };
    const fetchFn = vi.fn(async () => jsonResponse(200, response));
    const provider = createProxyAiProvider({ fetchFn: fetchFn as unknown as typeof fetch });

    const result = await provider.refine(REQUEST);
    expect(result).toEqual(response);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("/api/ai");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
  });

  it("rejects on a non-200 status (→ rules fallback upstream)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(429, { error: "rate" }));
    const provider = createProxyAiProvider({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(provider.refine(REQUEST)).rejects.toThrow(/429/);
  });

  it("rejects when the body is not valid JSON", async () => {
    const fetchFn = vi.fn(
      async () =>
        ({
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }) as unknown as Response
    );
    const provider = createProxyAiProvider({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(provider.refine(REQUEST)).rejects.toThrow();
  });

  it("rejects on a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const provider = createProxyAiProvider({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(provider.refine(REQUEST)).rejects.toThrow(/Failed to fetch/);
  });

  it("aborts (rejects) after the timeout", async () => {
    // fetch honors the AbortSignal: reject when it is aborted.
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    const provider = createProxyAiProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 5,
    });
    await expect(provider.refine(REQUEST)).rejects.toThrow();
  });
});

describe("FakeAiProvider", () => {
  it("resolves with a canned response and records the request", async () => {
    const response: AiResponse = {
      refinements: [{ id: "m1", confidence: 0.9, reason: "ok" }],
    };
    const provider = createFakeAiProvider({
      behavior: { kind: "respond", response },
    });
    const result = await provider.refine(REQUEST);
    expect(result).toEqual(response);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual(REQUEST);
  });

  it("defaults to an empty-refinements response", async () => {
    const provider = createFakeAiProvider();
    expect(await provider.refine(REQUEST)).toEqual({ refinements: [] });
  });

  it("rejects when configured to throw", async () => {
    const provider = createFakeAiProvider({
      behavior: { kind: "throw", error: new Error("boom") },
    });
    await expect(provider.refine(REQUEST)).rejects.toThrow("boom");
  });

  it("delegates to a supplied function", async () => {
    const provider = createFakeAiProvider({
      behavior: {
        kind: "fn",
        fn: (input) => ({
          refinements: input.candidates.map((c) => ({
            id: c.id,
            confidence: 1,
            reason: "from fn",
          })),
        }),
      },
    });
    const result = await provider.refine(REQUEST);
    expect(result.refinements[0]).toEqual({
      id: "m1",
      confidence: 1,
      reason: "from fn",
    });
  });
});
