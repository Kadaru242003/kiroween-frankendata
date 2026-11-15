/**
 * Feature: frankendata-smarter-ask, Property 1: thread bounds and privacy.
 * The derived thread has at most 3 turns, keeps the most recent, and never
 * contains a result row or cell value.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ASK_THREAD_MAX_TURNS, toThread, type AskTurn } from "./thread";

const turnArb = fc
  .record({
    q: fc.string({ maxLength: 40 }),
    sql: fc.string({ maxLength: 60 }),
    cols: fc.array(fc.string({ maxLength: 12 }), { maxLength: 5 }),
    n: fc.nat(1000),
    cells: fc.array(fc.uuid(), { minLength: 1, maxLength: 4 }),
  })
  .map(({ q, sql, cols, n, cells }): { turn: AskTurn; cells: string[] } => ({
    cells,
    turn: {
      question: q,
      outcome: {
        kind: "ok",
        sql,
        explanation: "e",
        columns: cols,
        rows: [cells],
        rowCount: n,
        capped: false,
      },
    },
  }));

describe("Feature: frankendata-smarter-ask, Property 1: thread bounds and privacy", () => {
  it("has at most 3 turns, the newest ones, and no row values", () => {
    fc.assert(
      fc.property(fc.array(turnArb, { maxLength: 8 }), (items) => {
        const turns = items.map((i) => i.turn);
        const thread = toThread(turns);
        expect(thread.length).toBeLessThanOrEqual(ASK_THREAD_MAX_TURNS);
        expect(thread.length).toBe(Math.min(turns.length, ASK_THREAD_MAX_TURNS));
        const kept = turns.slice(-ASK_THREAD_MAX_TURNS);
        thread.forEach((t, i) => {
          expect(t.rowCount).toBe(kept[i].outcome.rowCount);
        });
        const json = JSON.stringify(thread);
        for (const item of items) {
          for (const cell of item.cells) expect(json).not.toContain(cell);
        }
      }),
      { numRuns: 200 }
    );
  });
});
