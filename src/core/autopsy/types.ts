/**
 * Types and named constants for the Autopsy data quality report (Feature 4).
 *
 * Framework-agnostic (no React, DOM, or network). The report is a plain,
 * JSON-serializable structure so it can be rendered, exported, and compared in
 * tests. See `.kiro/specs/frankendata-autopsy/design.md`.
 */

import type { ColumnSchema, ColumnType } from "../types.js";
import type { CleaningKind, CleaningProposal } from "../stitching/types.js";

// ── Named constants (mirror requirements.md) ────────────────────────────────

/** The largest row count an Autopsy will analyze. */
export const AUTOPSY_MAX_ROWS = 1_000_000;
/** Most frequent values reported per low-cardinality column. */
export const AUTOPSY_TOP_VALUES = 5;
/** A column is low-cardinality when its non-null distinct count is at most this. */
export const AUTOPSY_LOW_CARDINALITY_MAX = 50;
/** Maximum outlier example values reported per column. */
export const AUTOPSY_OUTLIER_EXAMPLES = 5;
/** Multiplier of the interquartile range for outlier fences. */
export const AUTOPSY_IQR_FACTOR = 1.5;
/** A column with a null percent at or above this is at least `warning`. */
export const AUTOPSY_NULL_WARN_PCT = 5;
/** A column with a null percent at or above this is `critical`. */
export const AUTOPSY_NULL_CRIT_PCT = 50;
/** A numeric column whose outliers are at least this percent of non-nulls is `critical`. */
export const AUTOPSY_OUTLIER_CRIT_PCT = 10;
/** Performance target in milliseconds for 100,000 rows by 20 columns. */
export const AUTOPSY_TARGET_MS = 2000;

// ── Inputs ─────────────────────────────────────────────────────────────────

/** A table the user can open an Autopsy on (original or stitched result). */
export interface AutopsyTarget {
  tableName: string;
  schema: ColumnSchema[];
  rowCount: number;
}

// ── Findings ───────────────────────────────────────────────────────────────

export type ColumnStatus = "healthy" | "warning" | "critical";

export interface TopValue {
  value: string;
  count: number;
}

export interface OutlierFinding {
  count: number;
  lower: number;
  upper: number;
  examples: number[];
}

/**
 * Findings for one column. `conversionFailures` is intentionally absent:
 * intake records no per-column conversion failures, so the field is omitted
 * rather than invented (Requirement 2.6).
 */
export interface ColumnFinding {
  name: string;
  type: ColumnType;
  rows: number;
  nullCount: number;
  /** nullCount / rows * 100, or 0 when rows is 0. */
  nullPct: number;
  /** Count of distinct non-null values. */
  distinct: number;
  topValues?: TopValue[];
  /** number columns: numbers. date columns: `YYYY-MM-DD` strings. */
  min?: number | string;
  max?: number | string;
  mean?: number | string;
  median?: number | string;
  /** string columns: rows whose value differs from its whitespace-normalized form. */
  whitespaceRows?: number;
  /** string columns: groups of values that differ only by letter case. */
  caseVariantGroups?: number;
  /** string columns: variants found by the existing category-standardize rule. */
  categoryVariants?: number;
  outliers?: OutlierFinding;
  status: ColumnStatus;
  statusReasons: string[];
}

export interface HealthDeduction {
  code: string;
  reason: string;
  points: number;
}

export interface HealthResult {
  score: number;
  breakdown: HealthDeduction[];
}

/** A "Fix it" action mapping one finding to one existing cleaning proposal. */
export interface FixAction {
  proposalId: string;
  kind: CleaningKind;
  columnName?: string;
  label: string;
  proposal: CleaningProposal;
}

export type AutopsyStatus = "ok" | "too-large" | "error";

export interface AutopsyReport {
  version: 1;
  /** False for partial (progress) snapshots, true for the final report. */
  complete: boolean;
  status: AutopsyStatus;
  message?: string;
  tableName: string;
  rows: number;
  columnCount: number;
  columns: ColumnFinding[];
  duplicateRows: number;
  candidateKeys: string[];
  allNullColumns: string[];
  constantColumns: string[];
  health: HealthResult;
  fixes: FixAction[];
}
