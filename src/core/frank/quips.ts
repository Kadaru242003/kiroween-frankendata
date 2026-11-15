/**
 * Idle quips (pure): rare little remarks while the user is quiet. The scheduler
 * decides whether one may play now; the hook only keeps time and rolls the dice.
 */
import { FRANK_QUIP_GAP_MS, FRANK_QUIP_QUIET_MS } from "./constants.js";

export const QUIP_KINDS = ["read", "acorn", "stitches"] as const;
export type QuipKind = (typeof QUIP_KINDS)[number];

export interface QuipState {
  now: number;
  /** When the last quip played (or when he woke, so the first one waits too). */
  lastQuipAt: number;
  /** The last pointer, key or scroll activity. */
  lastActivityAt: number;
  /** A Reaction is playing or waiting. */
  busy: boolean;
  /** Awake, with tables loaded, and not asleep from idling. */
  awake: boolean;
}

/** Whether a quip may play now: never busy or asleep, spaced out, only when the user is still. */
export function quipDue(s: QuipState): boolean {
  if (s.busy || !s.awake) return false;
  if (s.now - s.lastQuipAt < FRANK_QUIP_GAP_MS) return false;
  return s.now - s.lastActivityAt >= FRANK_QUIP_QUIET_MS;
}

/** Pick a quip from a number in [0, 1), never the same one twice in a row. */
export function pickQuip(roll: number, last: QuipKind | null): QuipKind {
  const pool = QUIP_KINDS.filter((k) => k !== last);
  const r = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  return pool[Math.floor(r * pool.length)];
}
