/**
 * Shared type definitions, module interfaces, and named constants for the
 * FrankenData "Ask the Lab" chat-SQL pipeline (Feature 3). These types are
 * framework-agnostic (no React, DOM, or network) so the SQL validator, schema
 * budgeting, starter-question generation, result conversion, CSV export, and
 * the proxy handler can be unit- and property-tested in isolation, per
 * `.kiro/steering/structure.md`.
 *
 * Interfaces here mirror the design document (Module layout, SqlProvider and
 * proxy schemas). The LLM path reuses Feature 2's proxy limits and request
 * timeout from `../stitching/types.js` so there is a single source of truth for
 * `AI_PROXY_*` and `AI_REQUEST_TIMEOUT_MS`.
 */

import type { ColumnType } from "../types.js";

// Reuse the Feature 2 proxy limits + request timeout as the single source of
// truth. `/api/sql` reuses the same per-client limit and max payload size, and
// SHARES the same global daily cap counter (design: Proxy code sharing).
import {
  AI_PROXY_PER_CLIENT_LIMIT,
  AI_PROXY_DAILY_REQUEST_CAP,
  AI_PROXY_MAX_PAYLOAD_BYTES,
  AI_REQUEST_TIMEOUT_MS,
} from "../stitching/types.js";

export {
  AI_PROXY_PER_CLIENT_LIMIT,
  AI_PROXY_DAILY_REQUEST_CAP,
  AI_PROXY_MAX_PAYLOAD_BYTES,
  AI_REQUEST_TIMEOUT_MS,
};

// ── Named constants (mirror requirements.md Named Constants) ────────────────

/** Maximum length of an AskQuestion. */
export const ASK_MAX_QUESTION_CHARS = 300;
/** Maximum ResultTable rows shown in the on-screen table. */
export const ASK_RESULT_DISPLAY_CAP = 100;
/** LIMIT the SqlValidator appends when accepted SQL has none. */
export const ASK_DEFAULT_SQL_LIMIT = 1000;
/** Hard cap on rows the executor ever materializes (wraps the validated SQL). */
export const ASK_MAX_FETCH_ROWS = 5000;
/** Number of most-recent AskQuestions kept/shown for the current session. */
export const ASK_HISTORY_SIZE = 5;
/** Maximum StarterChips generated per QueryableTable. */
export const ASK_MAX_STARTER_CHIPS_PER_TABLE = 4;
/** Max distinct values a string column may have for a "rows per category" chip. */
export const ASK_CATEGORY_DISTINCT_MAX = 12;
/** Max categories a chart renders (pie groups the rest as "Other"; bar truncates). */
export const ASK_CHART_MAX_CATEGORIES = 20;
/** Max tables included in a SchemaSummary. */
export const ASK_SCHEMA_MAX_TABLES = 10;
/** Max columns per table included in a SchemaSummary. */
export const ASK_SCHEMA_MAX_COLUMNS_PER_TABLE = 40;
/** Max sample values per column included in a SchemaSummary. */
export const ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN = 3;
/** Max characters per sample value in a SchemaSummary (longer values truncated). */
export const ASK_SCHEMA_MAX_SAMPLE_CHARS = 30;
/** Max SchemaSummary size in bytes (16 KiB); the summary is trimmed to fit. */
export const ASK_SCHEMA_MAX_PAYLOAD_BYTES = 16384;

// ── Queryable tables ────────────────────────────────────────────────────────

/**
 * A table AskTheLab is allowed to query: every current `LoadedTable` plus the
 * Feature 2 `stitch_<n>_result` / `stitch_<n>_clean_*` tables present in
 * DuckDB-WASM. Carries just what the validator and schema builder need.
 */
export interface QueryableTable {
  /** The sanitized DuckDB table name (what SQL references). */
  tableName: string;
  /** The table's columns, in schema order. */
  columns: QueryableColumn[];
}

export interface QueryableColumn {
  name: string;
  type: ColumnType;
}

// ── Schema summary (what leaves the browser — never full rows) ──────────────

export interface SchemaColumn {
  name: string;
  type: ColumnType;
  /** Up to ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN values, each ≤ ASK_SCHEMA_MAX_SAMPLE_CHARS chars. */
  samples: string[];
}

export interface SchemaTable {
  tableName: string;
  columns: SchemaColumn[];
}

/** The bounded schema description sent to the LLM. Never contains full rows. */
export interface SchemaSummary {
  tables: SchemaTable[];
}

// ── SqlProvider request/response ────────────────────────────────────────────

/** A single `/api/sql` request: question + schema (+ optional repair follow-up). */
export interface SqlRequest {
  /** The AskQuestion, ≤ ASK_MAX_QUESTION_CHARS characters. */
  question: string;
  schema: SchemaSummary;
  /** Present only on a RepairCall: the failed SQL + DuckDB error to fix. */
  repair?: SqlRepair;
}

export interface SqlRepair {
  previousSql: string;
  error: string;
}

export type ChartType = "bar" | "line" | "pie";

/** An optional chart description returned alongside the SQL. */
export interface ChartSpec {
  type: ChartType;
  x: string;
  y: string;
}

/** The model's JSON-only response. */
export interface SqlResponse {
  sql: string;
  /** One sentence, plain text. */
  explanation: string;
  chart?: ChartSpec;
}

/**
 * The seam AskTheLab calls to turn a question + schema into `{ sql, explanation,
 * chart? }`. Production posts to `/api/sql`; tests inject a fake. Mirrors
 * Feature 2's `AiProvider`.
 */
export interface SqlProvider {
  ask(req: SqlRequest): Promise<SqlResponse>;
}

// ── SqlValidator result ─────────────────────────────────────────────────────

/**
 * The validator's outcome. On success it returns the accepted SQL
 * (comment-stripped, trailing-`;` trimmed, with a LIMIT enforced when the query
 * had none). On failure it returns a machine-readable reason.
 */
export type SqlValidationResult =
  | { ok: true; sql: string }
  | { ok: false; reason: SqlRejectReason };

/** Why the SqlValidator rejected a statement. */
export type SqlRejectReason =
  | "empty" // no statement after stripping comments
  | "not-select" // first keyword is not SELECT/WITH
  | "multiple-statements" // a non-trailing semicolon (chained statement)
  | "forbidden-keyword" // a forbidden keyword outside literals/identifiers
  | "table-function" // a file/network table function reference
  | "bad-table-position" // string/quoted-path/dotted-non-main in a table position
  | "unknown-table"; // a referenced table is not a QueryableTable or CTE alias

// ── Ask outcome (controller result; built in a later task) ──────────────────

/**
 * The non-throwing result of answering one question. Defined here so the
 * validator, converter, and (later) controller/UI share one shape. Row values
 * are already converted to safe display values by the result converter.
 */
export type AskOutcome =
  | {
      kind: "ok";
      sql: string;
      explanation: string;
      columns: string[];
      rows: DisplayValue[][];
      /** Total rows fetched (≤ ASK_MAX_FETCH_ROWS). */
      rowCount: number;
      /** True when the fetch hit ASK_MAX_FETCH_ROWS and the result is capped. */
      capped: boolean;
      /** A validated chart spec, if one applies. */
      chart?: ChartSpec;
    }
  | { kind: "ai-unavailable" }
  | { kind: "error"; message: string };

/** A result cell after safe conversion (never a BigInt, Date, or raw object). */
export type DisplayValue = string | number | boolean;
