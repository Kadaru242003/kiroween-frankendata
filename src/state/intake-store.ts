/**
 * Session-only intake store (Req 7.1, 8.2, 8.3, 9.3).
 *
 * `IntakeStore` holds the list of {@link LoadedTable} descriptors and
 * {@link IntakeError} entries for the current browser session only. It is a
 * small, framework-light observable: it exposes `getState` / `subscribe` for
 * `useSyncExternalStore` plus mutation methods (`addTable`, `addError`,
 * `reset`). There is NO persistence — nothing is written to `localStorage`,
 * `IndexedDB`, or any other backing store. Refreshing the page recreates an
 * empty store (and the app pairs it with a fresh DuckDB instance), so all
 * loaded tables and errors are retained in memory only for the lifetime of the
 * current session (Req 8).
 *
 * The store feeds the `TablePreview` (loaded tables) and `ErrorDisplay`
 * (errors) React components via {@link useIntakeStore}.
 */

import { useSyncExternalStore } from "react";
import type { IntakeError, LoadedTable } from "../core/types";

/** Immutable snapshot of the store's state handed to subscribers. */
export interface IntakeState {
  /** Successfully loaded tables, in the order they were added. */
  readonly tables: readonly LoadedTable[];
  /** Per-file failures captured during the pipeline, in order. */
  readonly errors: readonly IntakeError[];
}

/** A subscriber notified whenever the state changes. */
type Listener = () => void;

/** An empty snapshot, used as the initial state and on {@link IntakeStore.reset}. */
const EMPTY_STATE: IntakeState = Object.freeze({
  tables: Object.freeze([]) as readonly LoadedTable[],
  errors: Object.freeze([]) as readonly IntakeError[],
});

/**
 * A session-only, in-memory observable store of loaded tables and intake
 * errors.
 *
 * State is held as a single immutable {@link IntakeState} snapshot. Every
 * mutation replaces the snapshot with a new frozen object (so referential
 * identity changes exactly when the state changes, which `useSyncExternalStore`
 * relies on to detect updates) and then notifies subscribers.
 */
export class IntakeStore {
  private state: IntakeState = EMPTY_STATE;
  private readonly listeners = new Set<Listener>();

  /**
   * Per-session monotonically increasing source for {@link LoadedTable.loadId}.
   * Starts at 0; `addTable` pre-increments it so the first loaded table gets
   * `loadId === 1`. It is never decremented or reset — not even by
   * {@link IntakeStore.reset} — so ids are never reused within a session and a
   * re-dropped identical file always receives a strictly greater id (Feature 2
   * staleness, Req 3.8).
   */
  private nextLoadId = 0;

  /**
   * Return the current immutable state snapshot. The same reference is returned
   * until the next mutation, satisfying the stable-snapshot contract of
   * `useSyncExternalStore`.
   */
  getState = (): IntakeState => this.state;

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   *
   * Bound as an arrow-function property so it can be passed directly to
   * `useSyncExternalStore` without losing `this`.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Append a successfully loaded table and notify subscribers.
   *
   * The store is the authoritative source of {@link LoadedTable.loadId}: it
   * stamps the next value from its per-session sequence onto the stored table,
   * overwriting any `loadId` the caller may have set. This guarantees ids are
   * monotonically increasing and never reused, so re-adding a table with the
   * same `sourceFileName` and `rowCount` still yields a strictly greater id
   * (Feature 2 staleness, Req 3.8).
   */
  addTable(table: LoadedTable): void {
    const stamped: LoadedTable = { ...table, loadId: ++this.nextLoadId };
    this.state = Object.freeze({
      tables: Object.freeze([...this.state.tables, stamped]),
      errors: this.state.errors,
    });
    this.emit();
  }

  /** Append a per-file error and notify subscribers. */
  addError(error: IntakeError): void {
    this.state = Object.freeze({
      tables: this.state.tables,
      errors: Object.freeze([...this.state.errors, error]),
    });
    this.emit();
  }

  /**
   * Clear all tables and errors back to the initial empty state and notify
   * subscribers. Used to model a fresh session; it does not touch any
   * persistent storage because the store never writes to one.
   */
  reset(): void {
    if (this.state === EMPTY_STATE) {
      return;
    }
    this.state = EMPTY_STATE;
    this.emit();
  }

  /** Notify every current subscriber of a state change. */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * The app-wide session store instance. A single store backs the UI for the
 * current page load; a page refresh recreates the module (and therefore an
 * empty store), which is exactly the ephemeral behavior Req 8 requires.
 */
export const intakeStore = new IntakeStore();

/**
 * React hook that subscribes a component to an {@link IntakeStore} and returns
 * its current state. Defaults to the app-wide {@link intakeStore} so components
 * can call `useIntakeStore()` with no arguments; a specific store can be passed
 * for tests or isolated usage.
 *
 * Re-renders occur only when the store's snapshot reference changes, i.e. on an
 * `addTable`, `addError`, or state-changing `reset`.
 */
export function useIntakeStore(store: IntakeStore = intakeStore): IntakeState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
