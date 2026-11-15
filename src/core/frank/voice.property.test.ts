/**
 * Feature: frankendata-little-frank, Property 8: voice. Every Reaction bubble,
 * every guide answer (in any month) and every chip has no em dash or en dash.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GREETING, GUIDE_CHIPS, INTENTS } from "./guide";
import { reactionFor, type FrankEvent } from "./reactions";

const dash = /[\u2013\u2014]/;

describe("Feature: frankendata-little-frank, Property 8: voice", () => {
  it("has no dash in any guide text, in any month", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 11 }), (month) => {
        const now = new Date(2026, month, 15);
        for (const intent of INTENTS) {
          for (const line of intent.answer(now)) expect(line, intent.id).not.toMatch(dash);
          for (const q of intent.examples) expect(q).not.toMatch(dash);
        }
        for (const chip of GUIDE_CHIPS) expect(chip).not.toMatch(dash);
        expect(GREETING).not.toMatch(dash);
      })
    );
  });

  it("has no dash in any Reaction bubble", () => {
    const events: FrankEvent[] = [
      { type: "wake" }, { type: "files-loaded", tableCount: 3 }, { type: "stitch-open" }, { type: "approve" },
      { type: "approve-all" }, { type: "reject" }, { type: "confirm-stitch" }, { type: "stitch-applied" },
      { type: "undo-stitch" }, { type: "fan-out" }, { type: "autopsy-open" }, { type: "autopsy", score: 10 },
      { type: "autopsy", score: 70 }, { type: "autopsy", score: 99 }, { type: "autopsy-fix-all" },
      { type: "save-recipe" }, { type: "apply-recipe" }, { type: "ask-error" }, { type: "export" },
      { type: "ai-off" }, { type: "reset" }, { type: "quip", kind: "read" }, { type: "quip", kind: "acorn" },
      { type: "quip", kind: "stitches" },
    ];
    fc.assert(
      fc.property(fc.constantFrom(...events), fc.integer({ min: 1, max: 12 }), (event, count) => {
        const e = event.type === "poke" ? { type: "poke", count } : event;
        expect(reactionFor(e as FrankEvent)?.bubble ?? "").not.toMatch(dash);
      })
    );
    for (let count = 1; count <= 12; count += 1) {
      expect(reactionFor({ type: "poke", count })?.bubble ?? "").not.toMatch(dash);
    }
  });
});
