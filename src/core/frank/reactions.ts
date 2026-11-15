/**
 * Little Frank's event-to-reaction state machine (pure, no React, no DOM).
 *
 * An app event maps to at most one Reaction ({@link reactionFor}). Reactions
 * play one at a time through a tiny queue: while one plays, a newer one
 * replaces any waiting one (newest wins), so nothing ever piles up
 * ({@link enqueue}, {@link finish}). Poking escalates by count
 * ({@link pokeReaction}, {@link pokeStep}). Held Poses (asleep, bandaged, chart
 * sign, ...) are NOT here: they come from app state props.
 */

import {
  FRANK_POKE_EGG_COUNT,
  FRANK_POKE_RESET_MS,
} from "./constants.js";

/** Something that happened in the app. */
export type FrankEvent =
  | { type: "wake" }
  | { type: "files-loaded"; tableCount: number }
  | { type: "stitch-open" }
  | { type: "approve" }
  | { type: "approve-all" }
  | { type: "reject" }
  | { type: "confirm-stitch" }
  | { type: "stitch-applied" }
  | { type: "undo-stitch" }
  | { type: "fan-out" }
  | { type: "autopsy"; score: number }
  | { type: "autopsy-fix-all" }
  | { type: "save-recipe" }
  | { type: "apply-recipe" }
  | { type: "ask-error" }
  | { type: "export" }
  | { type: "ai-off" }
  | { type: "reset" }
  | { type: "poke"; count: number };

export type ReactionId =
  | "wake"
  | "catch"
  | "peer"
  | "nod"
  | "thumbs-up"
  | "shrug"
  | "sew"
  | "bandage"
  | "unravel"
  | "head-grab"
  | "autopsy-happy"
  | "autopsy-neutral"
  | "autopsy-faint"
  | "surgeon"
  | "write-scroll"
  | "stamp"
  | "smoke"
  | "wave-file"
  | "unplug"
  | "reset"
  | "poke-1"
  | "poke-2"
  | "poke-3"
  | "poke-4"
  | "poke-5"
  | "poke-egg";

/** One transient reaction: what to draw, what to say, how long it runs. */
export interface Reaction {
  id: ReactionId;
  /** Speech-bubble text, or null for none. */
  bubble: string | null;
  /** Animation length in ms (at most FRANK_REACTION_MAX_MS). */
  durationMs: number;
}

const r = (id: ReactionId, bubble: string | null, durationMs: number): Reaction => ({
  id,
  bubble,
  durationMs,
});

/** The health score at or above which the Autopsy makes him happy. */
export const AUTOPSY_HAPPY_SCORE = 85;
/** The health score below which the Autopsy makes him faint. */
export const AUTOPSY_FAINT_SCORE = 60;

/** "N table(s) on the slab." */
export function slabText(tableCount: number): string {
  const n = Number.isFinite(tableCount) ? Math.max(1, Math.floor(tableCount)) : 1;
  return `${n} ${n === 1 ? "table" : "tables"} on the slab.`;
}

/** Map an app event to the Reaction it triggers, or null for none. */
export function reactionFor(event: FrankEvent): Reaction | null {
  switch (event.type) {
    case "wake":
      return r("wake", "IT'S ALIVE!", 1400);
    case "files-loaded":
      return r("catch", slabText(event.tableCount), 1100);
    case "stitch-open":
      return r("peer", null, 1200);
    case "approve":
      return r("nod", null, 600);
    case "approve-all":
      return r("thumbs-up", null, 1000);
    case "reject":
      return r("shrug", null, 800);
    case "confirm-stitch":
      return r("sew", null, 1400);
    case "stitch-applied":
      return r("bandage", "Stitched!", 1000);
    case "undo-stitch":
      return r("unravel", null, 1200);
    case "fan-out":
      return r("head-grab", "More rows than you started with!", 1300);
    case "autopsy":
      if (event.score >= AUTOPSY_HAPPY_SCORE) return r("autopsy-happy", "Clean bill of health!", 1100);
      if (event.score < AUTOPSY_FAINT_SCORE) return r("autopsy-faint", "Oh no...", 1500);
      return r("autopsy-neutral", "Hmm, let me see.", 800);
    case "autopsy-fix-all":
      return r("surgeon", "Scalpel, please.", 1400);
    case "save-recipe":
      return r("write-scroll", null, 1300);
    case "apply-recipe":
      return r("stamp", "Recipe stamped.", 1100);
    case "ask-error":
      return r("smoke", null, 1200);
    case "export":
      return r("wave-file", "Bye, little file!", 1400);
    case "ai-off":
      return r("unplug", "Fully local.", 1300);
    case "reset":
      return r("reset", null, 1400);
    case "poke":
      return pokeReaction(event.count);
  }
}

// ── Queue ────────────────────────────────────────────────────────────────────

/** One Reaction plays; at most one (the newest) waits. */
export interface QueueState {
  current: Reaction | null;
  pending: Reaction | null;
  /** Bumps whenever a Reaction starts, so the same one twice restarts its animation. */
  seq: number;
}

export const EMPTY_QUEUE: QueueState = Object.freeze({
  current: null,
  pending: null,
  seq: 0,
});

/**
 * Add a Reaction. Idle: it starts. Busy: it waits, replacing any older waiting
 * one (newest wins). One exception: "N tables on the slab" arriving while the
 * wake plays or waits is dropped, because those files are part of the same
 * first load.
 */
export function enqueue(state: QueueState, reaction: Reaction): QueueState {
  if (
    reaction.id === "catch" &&
    (state.current?.id === "wake" || state.pending?.id === "wake")
  ) {
    return state;
  }
  if (state.current === null) {
    return { current: reaction, pending: null, seq: state.seq + 1 };
  }
  return { ...state, pending: reaction };
}

/** The current Reaction ended: start the waiting one, if any. */
export function finish(state: QueueState): QueueState {
  if (state.pending === null) {
    return { current: null, pending: null, seq: state.seq };
  }
  return { current: state.pending, pending: null, seq: state.seq + 1 };
}

// ── Poking ───────────────────────────────────────────────────────────────────

/** The escalation level (1 to 5) of a poke count below the egg; 6 is the egg. */
export function pokeLevel(count: number): 1 | 2 | 3 | 4 | 5 | 6 {
  const c = Math.max(1, Math.floor(count));
  if (c >= FRANK_POKE_EGG_COUNT) return 6;
  if (c === 1) return 1;
  if (c === 2) return 2;
  if (c <= 4) return 3;
  if (c <= 6) return 4;
  return 5;
}

/** The Reaction for the Nth poke in a row. */
export function pokeReaction(count: number): Reaction {
  switch (pokeLevel(count)) {
    case 1:
      return r("poke-1", "Hi!", 900);
    case 2:
      return r("poke-2", "Hehe", 900);
    case 3:
      return r("poke-3", "Hey!", 700);
    case 4:
      return r("poke-4", "Stop poking me!", 1000);
    case 5:
      return r("poke-5", "I mean it!", 1200);
    case 6:
      return r("poke-egg", "Happy Halloween!", 1400);
  }
}

export interface PokeState {
  count: number;
  lastAt: number | null;
}

export const NO_POKES: PokeState = Object.freeze({ count: 0, lastAt: null });

/**
 * Register a poke at `now`. The count starts again after FRANK_POKE_RESET_MS
 * without a poke, and after the easter egg. Returns the new state and the
 * Reaction to play.
 */
export function pokeStep(
  state: PokeState,
  now: number
): { state: PokeState; reaction: Reaction } {
  const fresh =
    state.lastAt === null || now - state.lastAt > FRANK_POKE_RESET_MS;
  const count = (fresh ? 0 : state.count) + 1;
  const reaction = pokeReaction(count);
  const next: PokeState =
    count >= FRANK_POKE_EGG_COUNT
      ? { count: 0, lastAt: now }
      : { count, lastAt: now };
  return { state: next, reaction };
}
