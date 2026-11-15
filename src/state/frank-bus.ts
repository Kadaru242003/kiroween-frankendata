/**
 * A tiny synchronous event bus that tells Little Frank what happened where no
 * store records it (the Autopsy score, "Fix all", save and apply recipe,
 * export). A throwing listener never breaks an emit or the handler that called
 * it. No persistence, no network.
 */
import type { FrankEvent } from "../core/frank/reactions";

export type FrankListener = (event: FrankEvent) => void;

export class FrankBus {
  private readonly listeners = new Set<FrankListener>();

  emit = (event: FrankEvent): void => {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not affect the app */
      }
    }
  };

  subscribe = (listener: FrankListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** The app-wide bus. */
export const frankBus = new FrankBus();
