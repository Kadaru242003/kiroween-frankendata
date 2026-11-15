/**
 * Feature: frankendata-little-frank, Property 3: guide matching. Every example
 * question of every intent (in any case, with extra punctuation) maps to that
 * intent; text with no keyword maps to the fallback.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { INTENTS, matchIntent } from "./guide";

const examples = INTENTS.flatMap((intent) => intent.examples.map((q) => ({ id: intent.id, q })));

describe("Feature: frankendata-little-frank, Property 3: guide matching", () => {
  it("maps every example question to its own intent, in any case and with punctuation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...examples),
        fc.constantFrom((s: string) => s, (s: string) => s.toUpperCase(), (s: string) => s.toLowerCase(), (s: string) => `  ${s}!!!  `, (s: string) => `... ${s} ???`),
        ({ id, q }, transform) => {
          const m = matchIntent(transform(q));
          expect(m.kind).toBe("intent");
          if (m.kind === "intent") expect(m.intent.id, q).toBe(id);
        }
      ),
      { numRuns: 400 }
    );
  });

  it("maps text with no keyword to the fallback", () => {
    // Consonant-only gibberish cannot contain a keyword, except the few keywords
    // that have no vowel (csv, sql, llm): those words are left out.
    const vowelless = new Set(INTENTS.flatMap((i) => i.keywords).filter((k) => !/[aeiouy]/.test(k)));
    const gibberish = fc
      .array(
        fc.stringMatching(/^[bcdfghjklmnpqrstvwxz]{2,8}$/).filter((w) => !vowelless.has(w)),
        { minLength: 0, maxLength: 6 }
      )
      .map((words) => words.join(" "));
    fc.assert(
      fc.property(gibberish, (text) => {
        expect(matchIntent(text).kind).toBe("fallback");
      }),
      { numRuns: 300 }
    );
    expect(matchIntent("").kind).toBe("fallback");
    expect(matchIntent("   ?!  ").kind).toBe("fallback");
    expect(matchIntent("what is the weather in paris").kind).toBe("fallback");
  });
});
