/**
 * The "Calm Frank" preference: animations off, poses and bubbles stay. Remembered
 * in localStorage. Every read and write is wrapped in try/catch so a blocked,
 * full or missing storage never throws (private mode, disabled cookies).
 */
import { FRANK_CALM_STORAGE_KEY } from "./constants";

/** The two storage methods used, so tests can inject a throwing storage. */
export interface CalmStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): CalmStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Read the preference. False when unset, unreadable or unavailable. */
export function readCalm(storage: CalmStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(FRANK_CALM_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the preference. Never throws. */
export function writeCalm(on: boolean, storage: CalmStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(FRANK_CALM_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked or full: the choice lasts for this session only */
  }
}
