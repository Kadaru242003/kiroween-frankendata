/**
 * ResetLock: observable "a reset is running" state (Smarter Ask, Requirement
 * 5). While busy, every load control is disabled and load handlers ignore
 * requests. A second reset while one runs is ignored, and the lock is always
 * released, even when the reset throws.
 */
import { useSyncExternalStore } from "react";

export interface ResetLockState {
  readonly busy: boolean;
}

/** The load controls are enabled only while no reset is running. */
export function loadControlsEnabled(state: ResetLockState): boolean {
  return !state.busy;
}

type Listener = () => void;

export class ResetLock {
  private state: ResetLockState = Object.freeze({ busy: false });
  private readonly listeners = new Set<Listener>();

  getState = (): ResetLockState => this.state;
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  isBusy(): boolean {
    return this.state.busy;
  }

  /** Run `fn` under the lock. Returns false (and does nothing) if already busy. */
  async run(fn: () => Promise<void>): Promise<boolean> {
    if (this.state.busy) return false;
    this.set(true);
    try {
      await fn();
    } finally {
      this.set(false);
    }
    return true;
  }

  private set(busy: boolean): void {
    this.state = Object.freeze({ busy });
    for (const l of this.listeners) l();
  }
}

export function useResetLock(lock: ResetLock): ResetLockState {
  return useSyncExternalStore(lock.subscribe, lock.getState);
}
