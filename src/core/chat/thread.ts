/**
 * Follow-up thread for "Ask the Lab" (Smarter Ask).
 *
 * A thread is the last few turns reduced to what may leave the browser:
 * question text, SQL text, result column names, and a row count. It never
 * contains result rows or cell values. Pure and framework-agnostic.
 */
import { AI_PROXY_MAX_PAYLOAD_BYTES } from "../stitching/types.js";
import {
  ASK_MAX_QUESTION_CHARS,
  type AskOutcome,
  type SqlRequest,
  type ThreadTurn,
} from "./types.js";

export type { ThreadTurn };

export const ASK_THREAD_MAX_TURNS = 3;
export const ASK_THREAD_MAX_SQL_CHARS = 1000;
export const ASK_THREAD_MAX_COLUMNS = 40;
export const ASK_THREAD_MAX_COLUMN_NAME_CHARS = 60;

/** One successful turn kept in memory in the browser (outcome includes rows). */
export interface AskTurn {
  question: string;
  outcome: Extract<AskOutcome, { kind: "ok" }>;
}

/** Reduce a turn to its privacy-safe thread form. Never reads rows. */
export function toThreadTurn(turn: AskTurn): ThreadTurn {
  const { question, outcome } = turn;
  return {
    question: question.slice(0, ASK_MAX_QUESTION_CHARS),
    sql: outcome.sql.slice(0, ASK_THREAD_MAX_SQL_CHARS),
    columns: outcome.columns
      .slice(0, ASK_THREAD_MAX_COLUMNS)
      .map((c) => c.slice(0, ASK_THREAD_MAX_COLUMN_NAME_CHARS)),
    rowCount: Number.isSafeInteger(outcome.rowCount) && outcome.rowCount >= 0 ? outcome.rowCount : 0,
  };
}

/** The thread for the most recent turns (oldest first, at most the max). */
export function toThread(turns: readonly AskTurn[]): ThreadTurn[] {
  return turns.slice(-ASK_THREAD_MAX_TURNS).map(toThreadTurn);
}

/** Exact UTF-8 byte length of a request body. */
export function requestBytes(request: SqlRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).length;
}

/**
 * Make a request fit the payload cap by dropping the OLDEST thread turns one at
 * a time; if it still does not fit with no turns, drop the thread entirely.
 * Returns the request to send (without a `thread` key when empty).
 */
export function fitRequestToCap(
  request: SqlRequest,
  maxBytes: number = AI_PROXY_MAX_PAYLOAD_BYTES
): SqlRequest {
  let thread = (request.thread ?? []).slice(-ASK_THREAD_MAX_TURNS);
  const build = (t: ThreadTurn[]): SqlRequest => {
    const { thread: _ignored, ...rest } = request;
    void _ignored;
    return t.length > 0 ? { ...rest, thread: t } : rest;
  };
  let candidate = build(thread);
  while (thread.length > 0 && requestBytes(candidate) > maxBytes) {
    thread = thread.slice(1);
    candidate = build(thread);
  }
  return candidate;
}
