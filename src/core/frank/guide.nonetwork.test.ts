/**
 * Feature: frankendata-little-frank, Property 5: the guide makes no network
 * call. A spy on fetch (and the other network APIs) must stay untouched while
 * every example question, chip and gibberish is answered; the module sources
 * must not reference a network API.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDE_CHIPS, INTENTS, answerFor } from "./guide";

afterEach(() => vi.unstubAllGlobals());

describe("Feature: frankendata-little-frank, Property 5: the guide makes no network call", () => {
  it("never calls fetch, XMLHttpRequest, WebSocket or sendBeacon while answering", () => {
    const fetchSpy = vi.fn();
    const xhr = vi.fn();
    const ws = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("WebSocket", ws);
    Object.defineProperty(globalThis.navigator, "sendBeacon", { value: beacon, configurable: true });
    const questions = [
      ...INTENTS.flatMap((i) => i.examples),
      ...GUIDE_CHIPS,
      "", "zzz", "what is the weather", "<script>alert(1)</script>", "x".repeat(5000),
    ];
    for (const q of questions) answerFor(q);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(ws).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("the frank core sources reference no network API and no provider module", () => {
    const dir = __dirname;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const banned of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "EventSource", "import(", "ai-provider", "sql-provider", "ai-proxy", "sql-proxy"]) {
        expect(src.includes(banned), `${f} mentions ${banned}`).toBe(false);
      }
    }
  });
});
