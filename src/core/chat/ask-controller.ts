/**
 * AskController — orchestrates answering one "Ask the Lab" question (Feature 3,
 * task 5).
 *
 * {@link createAskController} wires the pieces built in Groups A–B — the
 * {@link validateSql} safety validator, the schema builder, the result
 * converter — behind a single non-throwing {@link AskController.ask} that
 * returns an {@link AskOutcome}. It is the one place the question flow lives, so
 * the UI (task 6) only renders outcomes.
 *
 * Flow (design "AskController flow"):
 *   1. Chip path ({@link AskController.runSql}): validate the rule-built SQL →
 *      execute → convert. No LLM, works with AI off (Req 2.4, 2.5).
 *   2. Free-form, AI OFF: return `ai-unavailable` (no network; Req 6.4, 9.4).
 *   3. Free-form, AI ON: build SchemaSummary → provider.ask → validate →
 *      execute. On a DuckDB error for a valid query, make ONE RepairCall
 *      (re-validated, counts against proxy limits) and retry. A provider
 *      failure that looks like 429/503 → `ai-unavailable`; anything else still
 *      failing → a friendly `error` (Req 6.1–6.5).
 *   4. The executor ALWAYS wraps accepted SQL as
 *      `SELECT * FROM (<sql>) AS q LIMIT ASK_MAX_FETCH_ROWS` so a model-written
 *      huge LIMIT can never flood the browser (Req 5.9); a result reaching the
 *      cap is flagged `capped` (Req 5.10).
 *
 * `ask`/`runSql` NEVER throw (Req 6.6): every error path resolves to an
 * `error`/`ai-unavailable` outcome.
 *
 * Framework-agnostic: DuckDB is reached through an injected query runner and the
 * SqlProvider through the injected seam, so this is fully unit-testable with
 * fakes and no network (design "Testing strategy").
 */

import {
  ASK_MAX_FETCH_ROWS,
  ASK_MAX_QUESTION_CHARS,
  type AskOutcome,
  type ChartSpec,
  type SchemaSummary,
  type SqlProvider,
  type SqlResponse,
} from "./types.js";
import { validateSql } from "./sql-validator.js";
import {
  toDisplayRows,
  type TimestampColumns,
  type DateColumns,
} from "./result-convert.js";
import { validateChartSpec } from "./chart-spec.js";

/** A single executed query's rows + ordered columns (post-conversion input). */
export interface QueryExecResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** TIMESTAMP-family columns (epoch-ms → full ISO string). */
  timestampColumns?: TimestampColumns;
  /** DATE columns (epoch-ms → `YYYY-MM-DD` date-only string). */
  dateColumns?: DateColumns;
}

/**
 * Runs a (validator-accepted) SQL string against DuckDB. Injected so tests use
 * a fake and production passes `DuckDBService.query`-backed execution. Rejects
 * on a DuckDB error — the controller catches it to drive the repair path.
 */
export type QueryRunner = (sql: string) => Promise<QueryExecResult>;

/** Builds the bounded SchemaSummary for the current tables. Injected. */
export type SchemaSummaryProvider = () => Promise<SchemaSummary>;

export interface AskControllerDeps {
  /** Current queryable table names (for the SqlValidator allowlist). */
  getQueryableTableNames: () => string[];
  /** Executes validator-accepted SQL (already wrapped with the fetch cap). */
  runQuery: QueryRunner;
  /** True only when VITE_AI_ENABLED === "true" (the LLM path gate). */
  aiEnabled: boolean;
  /** The LLM seam. Absent/ignored when `aiEnabled` is false. */
  provider?: SqlProvider;
  /** Builds the SchemaSummary for the provider. Required when AI is enabled. */
  buildSchema?: SchemaSummaryProvider;
}

export interface AskController {
  /** Answer a free-form question (LLM path when enabled). */
  ask(question: string): Promise<AskOutcome>;
  /** Run a known, rule-built SQL (the StarterChip path). No LLM. */
  runSql(sql: string, explanation: string, chart?: ChartSpec): Promise<AskOutcome>;
}

const FRIENDLY_ERROR =
  "The lab could not answer that question. Try rephrasing it, or pick one of the starter questions.";

/** Wrap accepted SQL so no model-written LIMIT exceeds ASK_MAX_FETCH_ROWS. */
export function wrapWithFetchCap(sql: string): string {
  return `SELECT * FROM (${sql}) AS q LIMIT ${ASK_MAX_FETCH_ROWS}`;
}

/** Heuristic: does a provider failure look like an "AI unavailable" (429/503)? */
function isUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|503)\b/.test(msg) || /unavailable|rate|cap/i.test(msg);
}

export function createAskController(deps: AskControllerDeps): AskController {
  /** Validate → wrap → execute → convert → build an `ok` outcome. Never throws. */
  async function executeValidated(
    rawSql: string,
    explanation: string,
    chart: ChartSpec | undefined
  ): Promise<{ outcome: AskOutcome; duckdbError?: string }> {
    const validation = validateSql(rawSql, deps.getQueryableTableNames());
    if (!validation.ok) {
      return { outcome: { kind: "error", message: FRIENDLY_ERROR } };
    }
    try {
      const exec = await deps.runQuery(wrapWithFetchCap(validation.sql));
      const rows = toDisplayRows(
        exec.rows,
        exec.columns,
        exec.timestampColumns,
        exec.dateColumns,
      );
      const capped = rows.length >= ASK_MAX_FETCH_ROWS;
      return {
        outcome: {
          kind: "ok",
          sql: validation.sql,
          explanation,
          columns: exec.columns,
          rows,
          rowCount: rows.length,
          capped,
          chart: validateChartSpec(chart, exec.columns, rows),
        },
      };
    } catch (err) {
      // A DuckDB execution error (not a validation reject) — surfaced so the
      // caller can decide whether to attempt a repair.
      return {
        outcome: { kind: "error", message: FRIENDLY_ERROR },
        duckdbError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function runSql(
    sql: string,
    explanation: string,
    chart?: ChartSpec
  ): Promise<AskOutcome> {
    const { outcome } = await executeValidated(sql, explanation, chart);
    return outcome;
  }

  async function ask(question: string): Promise<AskOutcome> {
    const trimmed = question.slice(0, ASK_MAX_QUESTION_CHARS);

    // AI off → no network; point the user at the starter chips.
    if (!deps.aiEnabled || !deps.provider || !deps.buildSchema) {
      return { kind: "ai-unavailable" };
    }

    // Build the schema summary (bounded; never full rows).
    let schema: SchemaSummary;
    try {
      schema = await deps.buildSchema();
    } catch {
      return { kind: "error", message: FRIENDLY_ERROR };
    }

    // First LLM call.
    let first: SqlResponse;
    try {
      first = await deps.provider.ask({ question: trimmed, schema });
    } catch (err) {
      return isUnavailableError(err)
        ? { kind: "ai-unavailable" }
        : { kind: "error", message: FRIENDLY_ERROR };
    }

    const firstRun = await executeValidated(first.sql, first.explanation, first.chart);
    if (firstRun.outcome.kind === "ok") return firstRun.outcome;
    // Only a DuckDB execution error (not a validation reject) earns a repair.
    if (firstRun.duckdbError === undefined) return firstRun.outcome;

    // ONE RepairCall: send the failed SQL + error back to the model.
    let repaired: SqlResponse;
    try {
      repaired = await deps.provider.ask({
        question: trimmed,
        schema,
        repair: { previousSql: first.sql, error: firstRun.duckdbError },
      });
    } catch (err) {
      return isUnavailableError(err)
        ? { kind: "ai-unavailable" }
        : { kind: "error", message: FRIENDLY_ERROR };
    }

    const secondRun = await executeValidated(
      repaired.sql,
      repaired.explanation,
      repaired.chart
    );
    // Whatever the repair yields (ok or a friendly error), that is the result.
    return secondRun.outcome;
  }

  return { ask, runSql };
}
