/**
 * Shared type definitions, module interfaces, named constants, and the type
 * compatibility matrix for the FrankenData AI stitching/cleaning pipeline
 * (Feature 2). These types are framework-agnostic (no React, DOM, or network)
 * so the deterministic engine, scoring, validation, and SQL generation can be
 * unit- and property-tested in isolation.
 *
 * Interfaces here mirror the design document exactly (Module Interfaces, Named
 * Constants, Type compatibility matrix, and the AI request/response types).
 * Free-function implementations and the concrete engine/controller/provider
 * live in their own modules; the interfaces here are the shared contract.
 */

import type {
  ColumnType,
  ColumnSchema,
  LoadedTable,
} from "../types.js";

// ── Named constants (mirror requirements.md) ───────────────────────────────
export const MATCH_DISPLAY_THRESHOLD = 0.5;
export const HIGH_CONFIDENCE_THRESHOLD = 0.85;
export const AI_REQUEST_TIMEOUT_MS = 8000;
export const MAX_SAMPLE_VALUES_PER_COLUMN = 200;
export const AI_PROXY_PER_CLIENT_LIMIT = 20; // requests / hour / client
export const AI_PROXY_DAILY_REQUEST_CAP = 500; // requests / day / global
export const AI_PROXY_MAX_PAYLOAD_BYTES = 20480; // 20 KiB

// ── Type compatibility matrix ──────────────────────────────────────────────
/**
 * Used by matching (Req 1.5 — never match incompatible types) and by the
 * `typeCompat` score component. A `0.0` entry is a hard gate: the pair is
 * discarded before scoring. `string` is a weak-compatible bridge (0.3) because
 * Feature 1 falls columns back to `string`, so a genuinely-matching key can
 * surface typed on one side and `string` on the other.
 *
 * | left ⟍ right | number | boolean | date | string |
 * |--------------|:------:|:-------:|:----:|:------:|
 * | number       | 1.0    | 0.0     | 0.0  | 0.3    |
 * | boolean      | 0.0    | 1.0     | 0.0  | 0.3    |
 * | date         | 0.0    | 0.0     | 1.0  | 0.3    |
 * | string       | 0.3    | 0.3     | 0.3  | 1.0    |
 */
export const TYPE_COMPATIBILITY_MATRIX: Record<
  ColumnType,
  Record<ColumnType, number>
> = {
  number: { number: 1.0, boolean: 0.0, date: 0.0, string: 0.3 },
  boolean: { number: 0.0, boolean: 1.0, date: 0.0, string: 0.3 },
  date: { number: 0.0, boolean: 0.0, date: 1.0, string: 0.3 },
  string: { number: 0.3, boolean: 0.3, date: 0.3, string: 1.0 },
};

// ── Column reference ────────────────────────────────────────────────────────
export interface ColumnRef {
  tableName: string; // a LoadedTable.tableName
  columnName: string; // a column in that table's schema
  type: ColumnType;
}

// ── Which engine produced/last-touched a proposal (Req 6.8) ────────────────
export type ProposalSource = "rules" | "ai";

// ── Match proposal ─────────────────────────────────────────────────────────
export interface MatchProposal {
  id: string; // stable id derived from the (left,right) column pair
  left: ColumnRef;
  right: ColumnRef;
  confidence: number; // 0..1 (Req 1.3)
  reason: string; // one line (plain text)
  source: ProposalSource; // "rules" unless AI refined it
  // breakdown kept for the diff / debugging; deterministic
  components: { nameSim: number; typeCompat: number; valueOverlap: number };
}

// ── Cleaning proposal ──────────────────────────────────────────────────────
export type CleaningKind =
  | "whitespace-case" // trim + normalize whitespace/case for text columns
  | "category-standardize" // map variants → one canonical value
  | "duplicate-rows" // remove dup rows in cleaned copy, keep first
  | "outliers"; // add is_outlier boolean column (number cols only)

export interface CleaningProposal {
  id: string;
  target: { tableName: string; columnName?: string }; // columnName omitted for row-level (duplicates)
  kind: CleaningKind;
  before: unknown; // representative before value(s) for the diff
  after: unknown; // representative after value(s) for the diff
  reason: string; // one line (plain text)
  // For category-standardize: the editable canonical value + the variant map.
  canonical?: string;
  variantMap?: Record<string, string>;
}

export type Proposal = MatchProposal | CleaningProposal;

// ── Decisions & plan ───────────────────────────────────────────────────────
export type DecisionKind = "approved" | "rejected" | "edited";
export interface ApprovalDecision {
  proposalId: string;
  decision: DecisionKind;
  edit?: Partial<MatchProposal> | Partial<CleaningProposal>; // user edits
}

export interface StitchPlan {
  anchorTableName: string; // defaults to most-rows table (Req 7.2)
  joinKeysByPair: Record<string, string>; // "tableA|tableB" → MatchProposal.id (Req 7.4)
  approvedMatches: MatchProposal[];
  approvedCleanings: CleaningProposal[];
}

export interface StitchedTable extends LoadedTable {} // reuses Feature 1 descriptor

// ── Undo ────────────────────────────────────────────────────────────────────
export interface UndoStep {
  createdTableNames: string[]; // every stitch_* table created by the apply
}

// ── The deterministic engine ────────────────────────────────────────────────
export interface RulesEngine {
  match(tables: TableSample[]): MatchProposal[];
  /**
   * Produce per-table {@link CleaningProposal}s (Req 2.1–2.8).
   *
   * Whitespace/case and category-standardize proposals are derived purely from
   * the bounded {@link TableSample}s. The duplicate-rows and number-column
   * outlier proposals, however, carry before/after *counts* that must reflect
   * the FULL column, not just the ≤200 bounded distinct samples (the samples
   * omit per-value frequencies beyond the cap and would skew quartiles). Those
   * counts come from SQL issued over the whole table via the injected
   * {@link DuckDBService}, using the same `quantile_cont` Tukey fences the apply
   * step uses. `clean` is therefore async.
   */
  clean(tables: TableSample[]): Promise<CleaningProposal[]>;
}

export interface SampleValue {
  value: string | null;
  count: number; // COUNT(*) for this distinct value (frequency)
}

export interface TableSample {
  tableName: string;
  rowCount: number;
  schema: ColumnSchema[];
  // Up to MAX_SAMPLE_VALUES_PER_COLUMN distinct values per column, each with
  // its frequency, ordered by count DESC then value ASC (deterministic).
  samplesByColumn: Record<string, SampleValue[]>;
}

// ── Orchestration ────────────────────────────────────────────────────────────
export interface StitchController {
  computeProposals(): Promise<ProposalSet>; // reads samples, runs rules, refines via AI
  applyPlan(plan: StitchPlan): Promise<StitchedTable>;
  undo(): Promise<void>; // drops the created stitch_* tables
}

export interface ProposalSet {
  matches: MatchProposal[]; // already filtered to >= MATCH_DISPLAY_THRESHOLD for display
  cleanings: CleaningProposal[];
  aiUsed: boolean; // false when fallback occurred (drives AiNotice)
}

// ── AI provider (injected; fakeable) ─────────────────────────────────────────
export interface AiProvider {
  /**
   * Refine EXISTING matches only (Req 11.5). Receives column names + bounded
   * samples, never full rows. Resolves with refinements or rejects/throws on
   * any failure; the controller then falls back to the rules result.
   */
  refine(input: AiRequest): Promise<AiResponse>;
}

export interface AiSampleColumn {
  tableName: string;
  columnName: string;
  type: ColumnType;
  samples: string[]; // ≤ 5 values, each ≤ 40 chars (payload budget)
}

export interface AiCandidateMatch {
  id: string; // echoes an existing MatchProposal.id (Req 11.5)
  left: { tableName: string; columnName: string };
  right: { tableName: string; columnName: string };
  ruleConfidence: number; // the deterministic score; only sent if >= MATCH_DISPLAY_THRESHOLD
}

export interface AiRequest {
  columns: AiSampleColumn[]; // ≤ 40 columns; names + ≤ 5 short samples only (Req 6.2, 11)
  candidates: AiCandidateMatch[]; // ≤ 30 existing, already-visible matches to refine
}

export interface AiRefinement {
  id: string; // MUST match an existing MatchProposal.id
  confidence: number; // model's suggested 0..1 score
  reason: string; // short explanation (rendered as plain text)
}

export interface AiResponse {
  refinements: AiRefinement[];
}
