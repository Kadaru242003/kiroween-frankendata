/**
 * A read-only feed of what Little Frank is doing now: the Reaction that is
 * playing (with its sequence number) and whether Calm Frank is on. Frank's
 * controller is the only publisher, so anything decorative that should move
 * with him (the lab shelf) listens here instead of working the events out again.
 * No persistence, no network.
 */
import { readCalm } from "../core/frank/calm";
import type { Reaction } from "../core/frank/reactions";

export interface FrankFeedSnapshot {
  reaction: Reaction | null;
  /** Bumps whenever a Reaction starts (the same one twice is two strikes). */
  seq: number;
  calm: boolean;
}

export class FrankFeed {
  private snapshot: FrankFeedSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(calm: boolean = readCalm()) {
    this.snapshot = { reaction: null, seq: 0, calm };
  }

  getSnapshot = (): FrankFeedSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Publish the current state. Does nothing when nothing changed. */
  publish = (next: FrankFeedSnapshot): void => {
    const cur = this.snapshot;
    if (cur.reaction === next.reaction && cur.seq === next.seq && cur.calm === next.calm) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* a broken listener must not affect Frank */
      }
    }
  };
}

/** The app-wide feed. */
export const frankFeed = new FrankFeed();
