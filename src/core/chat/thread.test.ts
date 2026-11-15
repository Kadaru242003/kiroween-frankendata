import { describe, expect, it } from "vitest";
import {
  ASK_THREAD_MAX_COLUMNS,
  ASK_THREAD_MAX_SQL_CHARS,
  fitRequestToCap,
  requestBytes,
  toThread,
  type AskTurn,
} from "./thread";
import type { SqlRequest } from "./types";

const turn = (n: number, extra: Partial<AskTurn["outcome"]> = {}): AskTurn => ({
  question: `question ${n}`,
  outcome: {
    kind: "ok",
    sql: `SELECT ${n}`,
    explanation: "e",
    columns: ["a", "b"],
    rows: [["SECRET-VALUE", 1]],
    rowCount: 1,
    capped: false,
    ...extra,
  },
});

describe("toThread", () => {
  it("keeps the last 3 turns, oldest first, and no row values", () => {
    const t = toThread([turn(1), turn(2), turn(3), turn(4)]);
    expect(t.map((x) => x.question)).toEqual(["question 2", "question 3", "question 4"]);
    expect(JSON.stringify(t)).not.toContain("SECRET-VALUE");
    expect(Object.keys(t[0]).sort()).toEqual(["columns", "question", "rowCount", "sql"]);
  });
  it("truncates sql and columns", () => {
    const t = toThread([
      turn(1, {
        sql: "x".repeat(5000),
        columns: Array.from({ length: 100 }, (_, i) => `c${i}`.padEnd(200, "z")),
      }),
    ]);
    expect(t[0].sql).toHaveLength(ASK_THREAD_MAX_SQL_CHARS);
    expect(t[0].columns).toHaveLength(ASK_THREAD_MAX_COLUMNS);
    expect(t[0].columns[0].length).toBe(60);
  });
});

describe("fitRequestToCap", () => {
  const base: SqlRequest = { question: "q", schema: { tables: [] } };
  it("leaves a small request unchanged and omits an empty thread", () => {
    expect(fitRequestToCap(base)).toEqual(base);
    expect("thread" in fitRequestToCap({ ...base, thread: [] })).toBe(false);
  });
  it("drops the oldest turns first", () => {
    const thread = toThread([turn(1), turn(2), turn(3)]);
    const withThread = { ...base, thread };
    const oneTurn = requestBytes({ ...base, thread: thread.slice(-1) });
    const fitted = fitRequestToCap(withThread, oneTurn);
    expect(fitted.thread?.map((t) => t.question)).toEqual(["question 3"]);
  });
  it("drops the thread when even one turn does not fit", () => {
    const fitted = fitRequestToCap({ ...base, thread: toThread([turn(1)]) }, requestBytes(base));
    expect(fitted.thread).toBeUndefined();
  });
});
