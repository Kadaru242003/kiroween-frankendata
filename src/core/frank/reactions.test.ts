import { describe, expect, it } from "vitest";
import { FRANK_POKE_EGG_COUNT, FRANK_POKE_RESET_MS, FRANK_REACTION_MAX_MS } from "./constants";
import {
  EMPTY_QUEUE,
  NO_POKES,
  enqueue,
  finish,
  pokeLevel,
  pokeStep,
  reactionFor,
  slabText,
  type FrankEvent,
} from "./reactions";

const ev = (e: FrankEvent) => reactionFor(e);

describe("reactionFor: each event maps to its reaction", () => {
  it("wake: lightning, flash and sparks, with the It's alive! bubble", () => {
    expect(ev({ type: "wake" })).toEqual({ id: "wake", bubble: "It's alive!", durationMs: 1400 });
  });
  it("files loaded after waking: catch, with the slab count", () => {
    expect(ev({ type: "files-loaded", tableCount: 3 })).toMatchObject({ id: "catch" });
    expect(ev({ type: "files-loaded", tableCount: 3 })?.bubble).toMatch(/^3 tables on the slab\./);
    expect(slabText(1)).toBe("1 table on the slab.");
    expect(slabText(0)).toBe("1 table on the slab.");
    expect(slabText(2.7)).toBe("2 tables on the slab.");
  });
  it("stitch flow", () => {
    expect(ev({ type: "stitch-open" })?.id).toBe("peer");
    expect(ev({ type: "approve" })?.id).toBe("nod");
    expect(ev({ type: "approve-all" })?.id).toBe("thumbs-up");
    expect(ev({ type: "reject" })?.id).toBe("shrug");
    expect(ev({ type: "confirm-stitch" })?.id).toBe("sew");
    expect(ev({ type: "stitch-applied" })?.id).toBe("bandage");
    expect(ev({ type: "undo-stitch" })?.id).toBe("unravel");
    expect(ev({ type: "fan-out" })).toMatchObject({ id: "head-grab" });
    expect(ev({ type: "fan-out" })?.bubble).toMatch(/^More rows than you started with!/);
    expect(ev({ type: "stitch-applied" })?.bubble).toBe("Now neither of them is alone.");
    expect(ev({ type: "stitch-open" })?.bubble).toMatch(/^I was stitched from mismatched parts too\. Let's make your tables whole\./);
  });
  it("autopsy by score: 85 or above happy, below 60 faints, otherwise neutral", () => {
    expect(ev({ type: "autopsy", score: 100 })?.id).toBe("autopsy-happy");
    expect(ev({ type: "autopsy", score: 85 })?.id).toBe("autopsy-happy");
    expect(ev({ type: "autopsy", score: 84 })?.id).toBe("autopsy-neutral");
    expect(ev({ type: "autopsy", score: 60 })?.id).toBe("autopsy-neutral");
    expect(ev({ type: "autopsy", score: 59 })?.id).toBe("autopsy-faint");
    expect(ev({ type: "autopsy", score: 0 })?.id).toBe("autopsy-faint");
    expect(ev({ type: "autopsy-fix-all" })?.id).toBe("surgeon");
    expect(ev({ type: "autopsy-open" })).toMatchObject({ id: "examine", bubble: "Let me examine the patient." });
  });
  it("recipes, ask, export, AI and reset", () => {
    expect(ev({ type: "save-recipe" })?.id).toBe("write-scroll");
    expect(ev({ type: "apply-recipe" })?.id).toBe("stamp");
    expect(ev({ type: "ask-error" })?.id).toBe("smoke");
    expect(ev({ type: "export" })?.id).toBe("wave-file");
    expect(ev({ type: "ai-off" })).toMatchObject({ id: "unplug" });
    expect(ev({ type: "ai-off" })?.bubble).toMatch(/^Fully local\./);
    expect(ev({ type: "save-recipe" })?.bubble).toBe("Even I keep notes in a journal.");
    expect(ev({ type: "reset" })?.id).toBe("reset");
  });
  it("quips: reading, nibbling an acorn, looking at his stitches", () => {
    expect(ev({ type: "quip", kind: "read" })).toMatchObject({ id: "quip-read" });
    expect(ev({ type: "quip", kind: "acorn" })).toMatchObject({ id: "quip-acorn" });
    expect(ev({ type: "quip", kind: "stitches" })).toMatchObject({ id: "quip-stitches" });
  });
  it("is deterministic", () => {
    expect(ev({ type: "autopsy", score: 70 })).toEqual(ev({ type: "autopsy", score: 70 }));
  });
  it("keeps every reaction within the time limit", () => {
    for (const e of [{ type: "wake" }, { type: "reset" }, { type: "autopsy", score: 10 }] as FrankEvent[]) {
      expect(ev(e)!.durationMs).toBeLessThanOrEqual(FRANK_REACTION_MAX_MS);
    }
  });
});

describe("queue", () => {
  const a = reactionFor({ type: "approve" })!;
  const b = reactionFor({ type: "reject" })!;
  const c = reactionFor({ type: "stitch-open" })!;

  it("starts a reaction when idle", () => {
    const s = enqueue(EMPTY_QUEUE, a);
    expect(s.current).toBe(a);
    expect(s.pending).toBeNull();
    expect(s.seq).toBe(1);
  });
  it("keeps only the newest waiting reaction (newest wins)", () => {
    let s = enqueue(EMPTY_QUEUE, a);
    s = enqueue(s, b);
    s = enqueue(s, c);
    expect(s.current).toBe(a);
    expect(s.pending).toBe(c);
  });
  it("starts the waiting one when the current ends, then goes idle", () => {
    let s = enqueue(enqueue(EMPTY_QUEUE, a), b);
    s = finish(s);
    expect(s.current).toBe(b);
    expect(s.pending).toBeNull();
    expect(s.seq).toBe(2);
    s = finish(s);
    expect(s.current).toBeNull();
    expect(finish(s)).toEqual(s);
  });
  it("restarts the same reaction twice in a row (new seq)", () => {
    let s = enqueue(EMPTY_QUEUE, a);
    s = finish(s);
    s = enqueue(s, a);
    expect(s.seq).toBe(2);
  });
  it("drops 'tables on the slab' while the wake plays or waits (same first load)", () => {
    const wake = reactionFor({ type: "wake" })!;
    const files = reactionFor({ type: "files-loaded", tableCount: 3 })!;
    let s = enqueue(EMPTY_QUEUE, wake);
    expect(enqueue(s, files)).toBe(s);
    s = enqueue(enqueue(EMPTY_QUEUE, a), wake);
    expect(enqueue(s, files)).toBe(s);
    // After the wake ends it plays normally.
    const after = enqueue(finish(finish(enqueue(EMPTY_QUEUE, wake))), files);
    expect(after.current?.id).toBe("catch");
  });
});

describe("poking", () => {
  it("escalates and then plays the egg at the tenth poke", () => {
    let state = NO_POKES;
    const ids: string[] = [];
    for (let i = 0; i < FRANK_POKE_EGG_COUNT; i++) {
      const step = pokeStep(state, 1000 + i * 100);
      ids.push(step.reaction.id);
      state = step.state;
    }
    expect(ids).toEqual([
      "poke-1", "poke-2", "poke-3", "poke-3", "poke-4", "poke-4", "poke-5", "poke-5", "poke-5", "poke-egg",
    ]);
    expect(state.count).toBe(0);
    expect(pokeStep(state, 3000).reaction.id).toBe("poke-1");
  });
  it("starts again after a pause", () => {
    let s = pokeStep(NO_POKES, 0).state;
    s = pokeStep(s, 100).state;
    expect(s.count).toBe(2);
    expect(pokeStep(s, 100 + FRANK_POKE_RESET_MS + 1).reaction.id).toBe("poke-1");
    expect(pokeStep(s, 100 + FRANK_POKE_RESET_MS).reaction.id).toBe("poke-3");
  });
  it("levels are 1 to 5 and 6 for the egg", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(pokeLevel)).toEqual([1, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6]);
    expect(pokeLevel(0)).toBe(1);
  });
});

describe("poking while he is not alive (sleepy poke)", () => {
  it("gives the sleepy reaction and leaves the counter alone", () => {
    const first = pokeStep(NO_POKES, 1000, false);
    expect(first.reaction).toMatchObject({ id: "sleepy", bubble: "5 more minutes..." });
    expect(first.reaction.durationMs).toBeLessThanOrEqual(FRANK_REACTION_MAX_MS);
    expect(first.state.count).toBe(0);
    expect(first.state.lastAt).toBeNull();
    expect(first.repeat).toBe(false);
    // Many sleepy pokes never escalate.
    let state = first.state;
    for (let i = 1; i <= 15; i += 1) {
      const step = pokeStep(state, 1000 + i * 4000, false);
      expect(step.reaction.id).toBe("sleepy");
      expect(step.state.count).toBe(0);
      state = step.state;
    }
  });

  it("flags a second sleepy poke within 3 seconds as a repeat (same bubble), and not after", () => {
    const a = pokeStep(NO_POKES, 0, false);
    expect(pokeStep(a.state, 2900, false).repeat).toBe(true);
    expect(pokeStep(a.state, 3001, false).repeat).toBe(false);
  });

  it("does not disturb a live count, and live pokes work as before once he is alive", () => {
    let state = pokeStep(NO_POKES, 0).state;
    state = pokeStep(state, 100).state;
    expect(state.count).toBe(2);
    const sleepy = pokeStep(state, 200, false);
    expect(sleepy.state.count).toBe(2);
    expect(pokeStep(sleepy.state, 300).reaction.id).toBe("poke-3");
    expect(pokeStep(NO_POKES, 0, true).reaction.id).toBe("poke-1");
  });
});
