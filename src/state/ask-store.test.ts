/**
 * Unit tests for the session-only AskStore (bug fix: Reset lab clears it).
 *
 * Covers history capping/dedup, outcome + loading, and that reset() returns the
 * store to empty (no history, no outcome) — the behavior "Reset lab" relies on.
 */

import { describe, expect, it } from "vitest";
import { AskStore } from "./ask-store";
import { ASK_HISTORY_SIZE, type AskOutcome } from "../core/chat/types";

const OK: AskOutcome = {
  kind: "ok",
  sql: "SELECT 1",
  explanation: "x",
  columns: ["n"],
  rows: [[1]],
  rowCount: 1,
  capped: false,
};

describe("AskStore", () => {
  it("keeps most-recent questions first, de-duplicated and capped", () => {
    const store = new AskStore();
    for (let i = 0; i < ASK_HISTORY_SIZE + 3; i++) store.pushQuestion(`q${i}`);
    const { history } = store.getState();
    expect(history).toHaveLength(ASK_HISTORY_SIZE);
    // Most-recent first.
    expect(history[0]).toBe(`q${ASK_HISTORY_SIZE + 2}`);
    // Re-asking an existing question moves it to the front without duplicating.
    store.pushQuestion(history[2]);
    expect(store.getState().history[0]).toBe(history[2]);
    expect(new Set(store.getState().history).size).toBe(
      store.getState().history.length,
    );
  });

  it("stores an outcome and clears the loading flag", () => {
    const store = new AskStore();
    store.setLoading(true);
    expect(store.getState().loading).toBe(true);
    store.setOutcome(OK);
    expect(store.getState().outcome).toEqual(OK);
    expect(store.getState().loading).toBe(false);
  });

  it("reset() clears history, outcome, and loading", () => {
    const store = new AskStore();
    store.pushQuestion("q1");
    store.setOutcome(OK);
    store.setLoading(true);
    store.reset();
    expect(store.getState().history).toEqual([]);
    expect(store.getState().outcome).toBeNull();
    expect(store.getState().loading).toBe(false);
  });
});
