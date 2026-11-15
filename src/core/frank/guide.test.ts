import { describe, expect, it } from "vitest";
import { describeEgress } from "../egress-description";
import { GUIDE_MIN_INTENTS } from "./constants";
import {
  FALLBACK_TEXT,
  GUIDE_CHIPS,
  INTENTS,
  answerFor,
  contextTip,
  matchIntent,
  normalizeQuestion,
} from "./guide";

const text = (q: string) => answerFor(q).paragraphs.join("\n");

describe("intent table", () => {
  it("has enough intents, unique ids, keywords and examples", () => {
    expect(INTENTS.length).toBeGreaterThanOrEqual(GUIDE_MIN_INTENTS);
    expect(new Set(INTENTS.map((i) => i.id)).size).toBe(INTENTS.length);
    for (const i of INTENTS) {
      expect(i.keywords.length).toBeGreaterThan(0);
      expect(i.examples.length).toBeGreaterThanOrEqual(2);
      expect(i.answer(new Date()).length).toBeGreaterThan(0);
      for (const k of i.keywords) expect(k).toBe(normalizeQuestion(k));
    }
  });
  it("has the eight suggested chips, each mapping to an intent", () => {
    expect(GUIDE_CHIPS).toEqual([
      "How do I start?",
      "What does stitching do?",
      "Is my data safe?",
      "What is an Autopsy?",
      "How do recipes work?",
      "What can I ask the Lab?",
      "What does AI do here?",
      "How was this built?",
    ]);
    for (const chip of GUIDE_CHIPS) expect(matchIntent(chip).kind).toBe("intent");
  });
  it("uses no em dash or en dash in any answer, chip or the fallback", () => {
    const all = [FALLBACK_TEXT, ...GUIDE_CHIPS, ...INTENTS.flatMap((i) => [...i.examples, ...i.answer(new Date())])];
    for (const s of all) expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("Frank's voice and lore (the 1818 novel)", () => {
  const nov = new Date(2026, 10, 15);
  const jun = new Date(2026, 5, 15);
  const body = (q: string, now = jun) => answerFor(q, now).paragraphs.join(" ");
  const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean).length;

  it("keeps every answer to 1 to 3 sentences, except the privacy answer", () => {
    for (const i of INTENTS) {
      if (i.id === "privacy") continue;
      const n = sentences(i.answer(nov).join(" "));
      expect(n, i.id).toBeGreaterThanOrEqual(1);
      expect(n, i.id).toBeLessThanOrEqual(3);
    }
  });
  it("ties the lore to the features", () => {
    expect(body("is my data safe")).toContain(
      "I learned everything by watching quietly through a crack in the wall. I watch your data the same way. I never carry it off."
    );
    expect(body("what does stitching do")).toContain("I was stitched from mismatched parts too. Let's make your tables whole.");
    expect(body("what is an autopsy")).toContain("Let me examine the patient.");
    expect(body("how do recipes work")).toContain("Even I keep notes in a journal.");
  });
  it("answers who, eat, read and Frankenstein from the novel", () => {
    expect(body("who are you")).toMatch(/Little Frank/);
    expect(body("what do you eat")).toMatch(/acorns and berries/);
    expect(body("what do you eat")).toMatch(/never meat/);
    const read = body("what do you read");
    for (const book of ["Paradise Lost", "Plutarch's Lives", "The Sorrows of Young Werther"]) expect(read).toContain(book);
    expect(read).toMatch(/chink in a cottage wall/);
    const fr = body("are you frankenstein");
    expect(fr).toMatch(/Frankenstein was my maker, Victor/);
    expect(fr).toMatch(/Little Frank/);
  });
  it("says the novel's dreary November, and 'That's this month!' only in November", () => {
    expect(body("when were you made")).toMatch(/a dreary night of November/);
    expect(body("when were you made", jun)).not.toMatch(/this month/);
    expect(body("when were you made", nov)).toMatch(/That's this month!/);
    expect(answerFor("when were you made", nov).intentId).toBe("born");
  });
  it("keeps quotes from the novel short and mentions no film", () => {
    for (const i of INTENTS) {
      const text = i.answer(nov).join(" ");
      for (const quoted of text.match(/"[^"]+"/g) ?? []) expect(quoted.split(/\s+/).length).toBeLessThan(15);
      expect(text.toLowerCase()).not.toMatch(/1931|karloff|igor|boris/);
    }
  });
});

describe("matching", () => {
  it("is case-insensitive and ignores punctuation", () => {
    expect(matchIntent("IS MY DATA SAFE??").kind).toBe("intent");
    expect(answerFor("IS MY DATA SAFE??").intentId).toBe("privacy");
    expect(answerFor("how   do I...  start").intentId).toBe("start");
  });
  it("matches synonyms", () => {
    expect(answerFor("is it private").intentId).toBe("privacy");
    expect(answerFor("can I merge two tables").intentId).toBe("stitching");
    expect(answerFor("download my result").intentId).toBe("export");
  });
  it("falls back for unknown text and offers the chips", () => {
    const a = answerFor("what is the capital of France");
    expect(a.intentId).toBeNull();
    expect(a.paragraphs).toEqual(["I only know about this lab. Try one of these:"]);
    expect(a.showChips).toBe(true);
    expect(answerFor("How do I start?").showChips).toBe(false);
  });
});

describe("required answers", () => {
  it("the privacy answer contains every line of the 'What leaves the browser?' text, verbatim", () => {
    const body = text("is my data safe");
    const egress = describeEgress();
    for (const line of egress.sent) expect(body).toContain(line);
    expect(body).toContain(egress.neverSent);
    expect(body).toMatch(/only in this browser tab/);
    expect(body).toMatch(/Nothing is uploaded/);
    expect(body).toMatch(/refresh clears/);
    expect(body).toMatch(/With AI off, nothing is sent at all\./);
  });
  it("the built answer says spec-driven with Kiro and names no other AI tool", () => {
    const body = text("how was this built");
    expect(body).toMatch(/spec-driven with Kiro/);
    for (const s of ["specs", "requirements", "steering", "hooks", "MCP"]) expect(body.toLowerCase()).toContain(s.toLowerCase());
    for (const other of ["chatgpt", "gpt", "openai", "copilot", "claude", "anthropic", "gemini", "cursor", "codex", "llama"]) {
      expect(body.toLowerCase()).not.toContain(other);
    }
  });
  it("the AI answer says optional, fully offline, the header switch, and names no vendor", () => {
    const body = text("what does ai do here");
    expect(body).toMatch(/optional/);
    expect(body).toMatch(/fully offline/);
    expect(body).toMatch(/header/);
    for (const other of ["chatgpt", "openai", "claude", "anthropic", "gemini"]) expect(body.toLowerCase()).not.toContain(other);
  });
});

describe("contextTip", () => {
  const s = (tableCount: number, proposalsPending: boolean, stitched: boolean) => contextTip({ tableCount, proposalsPending, stitched });
  it("picks the tip for the state", () => {
    expect(s(0, false, false)).toBe("Click Load business demo to wake me up.");
    expect(s(2, false, false)).toBe("Click Stitch tables.");
    expect(s(1, false, false)).toBe("Add another file, then click Stitch tables.");
    expect(s(2, true, false)).toBe("Approve the matches you trust, then Confirm & stitch.");
    expect(s(2, true, true)).toBe("Save a recipe, or ask the Lab a question.");
    expect(s(3, false, true)).toBe("Save a recipe, or ask the Lab a question.");
  });
});
