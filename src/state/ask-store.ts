/**
 * Session-only "Ask the Lab" store (Feature 3, task 6).
 *
 * `AskStore` holds the transient chat-SQL UI state for the current browser
 * session only: the last {@link ASK_HISTORY_SIZE} questions asked and the most
 * recent {@link AskOutcome}. Like {@link import("./intake-store").IntakeStore}
 * and the stitch store it is a tiny observable (`getState` / `subscribe`) with
 * NO persistence — a page refresh recreates an empty store. It has no React
 * dependency itself; a React layer subscribes via {@link useAskStore}
 * (`useSyncExternalStore`).
 *
 * Scope boundaries (Req 11): history is a convenience list of recent question
 * TEXT only — there is no multi-turn chat memory (each question is answered
 * independently) and nothing is persisted or saved.
 */

import { useSyncExternalStore } from "react";
import { ASK_HISTORY_SIZE, type AskOutcome } from "../core/chat/types";
import { ASK_THREAD_MAX_TURNS, type AskTurn } from "../core/chat/thread";

/** Immutable snapshot of the ask store handed to subscribers. */
export interface AskState {
  /** Most-recent questions first, capped at ASK_HISTORY_SIZE. */
  readonly history: readonly string[];
  /** The outcome of the latest answered question, or null before any. */
  readonly outcome: AskOutcome | null;
  /** True while a question is being answered (drives the loading state). */
  readonly loading: boolean;
  /**
   * The most recent successful turns (at most ASK_THREAD_MAX_TURNS, oldest
   * first), kept in memory only. They feed the thread cards and, reduced to
   * names and counts, the follow-up thread.
   */
  readonly turns: readonly AskTurn[];
}

type Listener = () => void;

const EMPTY_STATE: AskState = Object.freeze({
  history: Object.freeze([]) as readonly string[],
  outcome: null,
  loading: false,
  turns: Object.freeze([]) as readonly AskTurn[],
});

/** A session-only, in-memory observable store for the Ask the Lab panel. */
export class AskStore {
  private state: AskState = EMPTY_STATE;
  private readonly listeners = new Set<Listener>();

  getState = (): AskState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Enter the loading state (a question is in flight). */
  setLoading(loading: boolean): void {
    if (this.state.loading === loading) return;
    this.state = Object.freeze({ ...this.state, loading });
    this.emit();
  }

  /**
   * Record a question in the history (most-recent first, de-duplicated,
   * capped at {@link ASK_HISTORY_SIZE}). Blank questions are ignored.
   */
  pushQuestion(question: string): void {
    const q = question.trim();
    if (q.length === 0) return;
    const next = [q, ...this.state.history.filter((h) => h !== q)].slice(
      0,
      ASK_HISTORY_SIZE
    );
    this.state = Object.freeze({
      ...this.state,
      history: Object.freeze(next),
    });
    this.emit();
  }

  /** Store the latest outcome and clear the loading flag. */
  setOutcome(outcome: AskOutcome): void {
    this.state = Object.freeze({ ...this.state, outcome, loading: false });
    this.emit();
  }

  /** Record a successful turn (newest last), keeping at most the last 3. */
  pushTurn(question: string, outcome: Extract<AskOutcome, { kind: "ok" }>): void {
    const next = [...this.state.turns, { question, outcome }].slice(
      -ASK_THREAD_MAX_TURNS
    );
    this.state = Object.freeze({ ...this.state, turns: Object.freeze(next) });
    this.emit();
  }

  /** "New topic": forget the turns (the answer on screen stays). */
  clearThread(): void {
    if (this.state.turns.length === 0) return;
    this.state = Object.freeze({
      ...this.state,
      turns: Object.freeze([]) as readonly AskTurn[],
    });
    this.emit();
  }

  /** Clear the current outcome and the turns (e.g. when the tables change). */
  clearOutcome(): void {
    if (
      this.state.outcome === null &&
      !this.state.loading &&
      this.state.turns.length === 0
    ) {
      return;
    }
    this.state = Object.freeze({
      ...this.state,
      outcome: null,
      loading: false,
      turns: Object.freeze([]) as readonly AskTurn[],
    });
    this.emit();
  }

  /** Reset to the empty initial state (fresh session). */
  reset(): void {
    if (this.state === EMPTY_STATE) return;
    this.state = EMPTY_STATE;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * React hook subscribing a component to an {@link AskStore}. There is no
 * app-wide singleton — the ask stack is created in {@link import("../App").default}
 * and the store passed in explicitly (like the stitch store).
 */
export function useAskStore(store: AskStore): AskState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
