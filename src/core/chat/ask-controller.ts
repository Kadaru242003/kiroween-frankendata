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
  ASK_REPAIR_SQL_MAX_CHARS,
  type AskOutcome,
  type ChartSpec,
  type SchemaSummary,
  type SqlProvider,
  type SqlRejectReason,
  type SqlResponse,
  type ThreadTurn,
} from "./types.js";
import { validateSql } from "./sql-validator.js";
import {
  toDisplayRows,
  type TimestampColumns,
  type DateColumns,
} from "./result-convert.js";
import { validateChartSpec } from "./chart-spec.js";
import { chooseChart } from "./chart-choice.js";
import { fitRequestToCap } from "./thread.js";
import { redactDuckDbError } from "./redact-error.js";

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

/**
 * Why a question could not be answered: the category only, never a value (no SQL
 * text, no cell, no question). Reported through {@link AskControllerDeps.onDiagnostic}
 * so a developer can see what failed without anything sensitive being logged.
 */
export type AskFailureCategory =
  | `rejected:${SqlRejectReason}`
  | "execution"
  | "timeout"
  | "provider-error"
  | "schema";

export interface AskDiagnostic {
  /** Which path failed: a starter chip, a typed question, or the repair retry. */
  path: "chip" | "ask" | "repair";
  category: AskFailureCategory;
}

export interface AskControllerDeps {
  /**
   * Optional hook told the failure category (see {@link AskFailureCategory}).
   * The app wires it to the console in development only. Never throws into the
   * controller.
   */
  onDiagnostic?: (diagnostic: AskDiagnostic) => void;
  /**
   * How long a starter chip waits before its one retry (ms). Default
   * {@link CHIP_RETRY_DELAY_MS}; tests pass 0.
   */
  chipRetryDelayMs?: number;
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
  ask(question: string, thread?: ThreadTurn[]): Promise<AskOutcome>;
  /** Run a known, rule-built SQL (the StarterChip path). No LLM. */
  runSql(sql: string, explanation: string, chart?: ChartSpec): Promise<AskOutcome>;
}

const FRIENDLY_ERROR =
  "The lab could not answer that question. Try rephrasing it, or pick one of the starter questions.";

/** Specific, non-leaky reasons for a typed question that failed (no SQL, names or values). */
export const READ_ONLY_MESSAGE =
  "The lab only runs read-only queries on your loaded tables. Try rephrasing your question, or pick one of the starter questions.";
export const UNKNOWN_TABLE_MESSAGE =
  "That question needs a table the lab does not have loaded. Try asking about one of your loaded tables, or pick one of the starter questions.";
export const EXECUTION_MESSAGE =
  "The lab could not run that query on your data, even after a second try. Try rephrasing your question, or pick one of the starter questions.";
export const TIMEOUT_MESSAGE = "The lab took too long to answer, try again.";
export const PROVIDER_MESSAGE =
  "The lab could not get an answer just now, try again in a moment, or pick one of the starter questions.";
/** Pause before a starter chip's single retry. */
export const CHIP_RETRY_DELAY_MS = 75;
/** A starter chip runs local SQL; if it fails, say so plainly. */
export const CHIP_MESSAGE =
  "That starter question could not run just now, try it again.";

/** Wrap accepted SQL so no model-written LIMIT exceeds ASK_MAX_FETCH_ROWS. */
export function wrapWithFetchCap(sql: string): string {
  return `SELECT * FROM (${sql}) AS q LIMIT ${ASK_MAX_FETCH_ROWS}`;
}

/** Did the provider call time out (the client aborts after AI_REQUEST_TIMEOUT_MS)? */
function isTimeoutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || name === "TimeoutError" || /abort|timed? ?out/i.test(msg);
}

/** The specific message for a validator rejection of a typed question's SQL. */
function rejectionMessage(reason: SqlRejectReason): string {
  return reason === "unknown-table" || reason === "bad-table-position"
    ? UNKNOWN_TABLE_MESSAGE
    : READ_ONLY_MESSAGE;
}

/** Heuristic: does a provider failure look like an "AI unavailable" (429/503)? */
function isUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|503)\b/.test(msg) || /unavailable|rate|cap/i.test(msg);
}

export function createAskController(deps: AskControllerDeps): AskController {
  /** Validate → wrap → execute → convert → build an `ok` outcome. Never throws. */
  function report(path: AskDiagnostic["path"], category: AskFailureCategory): void {
    try {
      deps.onDiagnostic?.({ path, category });
    } catch {
      /* a diagnostics hook must never affect an answer */
    }
  }

  async function executeValidated(
    rawSql: string,
    explanation: string,
    chart: ChartSpec | undefined,
    path: AskDiagnostic["path"] = "ask"
  ): Promise<{ outcome: AskOutcome; duckdbError?: string; rejected?: SqlRejectReason }> {
    const validation = validateSql(rawSql, deps.getQueryableTableNames());
    if (!validation.ok) {
      report(path, `rejected:${validation.reason}`);
      return { outcome: { kind: "error", message: FRIENDLY_ERROR }, rejected: validation.reason };
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
      const temporal = new Set<string>([
        ...(exec.dateColumns ?? []),
        ...(exec.timestampColumns ?? []),
      ]);
      // A temporal plus numeric result is always a line chart; every other
      // chart still comes from a validated bar spec, as before.
      const auto = chooseChart(exec.columns, rows, temporal);
      const resolvedChart =
        auto?.type === "line" ? auto : validateChartSpec(chart, exec.columns, rows);
      return {
        outcome: {
          kind: "ok",
          sql: validation.sql,
          explanation,
          columns: exec.columns,
          rows,
          rowCount: rows.length,
          capped,
          chart: resolvedChart,
          ...(temporal.size > 0 ? { temporalColumns: [...temporal].sort() } : {}),
        },
      };
    } catch (err) {
      // A DuckDB execution error (not a validation reject) — surfaced so the
      // caller can decide whether to attempt a repair.
      report(path, "execution");
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
    // A starter's SQL is built by rules, with no model involved, and was valid
    // when its chip was made. If it fails, the cause is almost always timing
    // (the table list refreshing, one query racing another). Try once more with
    // a freshly read allowlist before giving up.
    const first = await executeValidated(sql, explanation, chart, "chip");
    if (first.outcome.kind === "ok") return first.outcome;
    const wait = deps.chipRetryDelayMs ?? CHIP_RETRY_DELAY_MS;
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    const second = await executeValidated(sql, explanation, chart, "chip");
    return second.outcome.kind === "ok" ? second.outcome : { kind: "error", message: CHIP_MESSAGE };
  }

  /** Map a provider failure to an outcome: unavailable, timed out, or a general failure. */
  function providerFailure(err: unknown, path: "ask" | "repair"): AskOutcome {
    if (isUnavailableError(err)) return { kind: "ai-unavailable" };
    if (isTimeoutError(err)) {
      report(path, "timeout");
      return { kind: "error", message: TIMEOUT_MESSAGE };
    }
    report(path, "provider-error");
    return { kind: "error", message: PROVIDER_MESSAGE };
  }

  async function ask(question: string, thread: ThreadTurn[] = []): Promise<AskOutcome> {
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
      report("ask", "schema");
      return { kind: "error", message: FRIENDLY_ERROR };
    }

    // First LLM call.
    let first: SqlResponse;
    try {
      first = await deps.provider.ask(
        fitRequestToCap({ question: trimmed, schema, thread })
      );
    } catch (err) {
      return providerFailure(err, "ask");
    }

    const firstRun = await executeValidated(first.sql, first.explanation, first.chart, "ask");
    if (firstRun.outcome.kind === "ok") return firstRun.outcome;
    // A validation reject is final: say why (read-only, or an unknown table).
    if (firstRun.rejected !== undefined) {
      return { kind: "error", message: rejectionMessage(firstRun.rejected) };
    }
    // Only a DuckDB execution error earns a repair.
    if (firstRun.duckdbError === undefined) return firstRun.outcome;

    // ONE RepairCall: send the failed SQL + error back to the model.
    let repaired: SqlResponse;
    try {
      repaired = await deps.provider.ask(
        fitRequestToCap({
          question: trimmed,
          schema,
          thread,
          repair: {
            previousSql: first.sql.slice(0, ASK_REPAIR_SQL_MAX_CHARS),
            // No cell value may leave the browser: DuckDB quotes offending values.
            error: redactDuckDbError(firstRun.duckdbError),
          },
        })
      );
    } catch (err) {
      return providerFailure(err, "repair");
    }

    const secondRun = await executeValidated(
      repaired.sql,
      repaired.explanation,
      repaired.chart,
      "repair"
    );
    if (secondRun.outcome.kind === "ok") return secondRun.outcome;
    // The repair is the last try: say why it failed.
    if (secondRun.rejected !== undefined) {
      return { kind: "error", message: rejectionMessage(secondRun.rejected) };
    }
    return { kind: "error", message: EXECUTION_MESSAGE };
  }

  return { ask, runSql };
}
