/**
 * The exact list of what leaves the browser when AI is On, built from the same
 * constants the payload builders use, so the text cannot drift from the code.
 * Shown in the "What leaves the browser?" disclosure.
 */
import { MAX_COLUMNS, MAX_SAMPLE_CHARS, MAX_SAMPLES_PER_COLUMN } from "./stitching/ai-budget.js";
import {
  ASK_MAX_QUESTION_CHARS,
  ASK_SCHEMA_MAX_SAMPLE_CHARS,
  ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN,
} from "./chat/types.js";
import { ASK_THREAD_MAX_TURNS } from "./chat/thread.js";

export function describeEgress(): { sent: string[]; neverSent: string } {
  return {
    sent: [
      "Column names and column types of your tables.",
      `Stitching: up to ${MAX_SAMPLES_PER_COLUMN} short sample values per column (each cut to ${MAX_SAMPLE_CHARS} characters), for at most ${MAX_COLUMNS} columns.`,
      `Ask the Lab: up to ${ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN} short sample values per column (each cut to ${ASK_SCHEMA_MAX_SAMPLE_CHARS} characters).`,
      `Ask the Lab: the question text you type (at most ${ASK_MAX_QUESTION_CHARS} characters).`,
      `Follow-up questions: your previous questions (at most ${ASK_THREAD_MAX_TURNS} turns), the SQL that answered them, and the result column names and row counts.`,
      "If a query fails, the error message with values removed.",
    ],
    neverSent: "Your rows are never sent, and neither are result values.",
  };
}
