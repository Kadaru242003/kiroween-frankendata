/**
 * Shared types and named constants for Feature 5 (Recipes and export).
 * Framework-agnostic: no React, DOM, DuckDB, or network.
 */
import type {
  ApprovalDecision,
  ProposalSet,
} from "../stitching/types";
import type { ColumnType } from "../types";

// ── Named constants (mirror requirements.md) ───────────────────────────────
export const RECIPE_FORMAT = "frankendata-recipe";
export const RECIPE_VERSION = 1;
export const RECIPE_MAX_BYTES = 262144;
export const RECIPE_MAX_TABLES = 20;
export const RECIPE_MAX_COLUMNS_PER_TABLE = 200;
export const RECIPE_MAX_ITEMS = 500;
export const RECIPE_MAX_NAME_LENGTH = 200;
export const RECIPE_MAX_VARIANTS = 200;
export const RECIPE_MAX_VALUE_LENGTH = 200;
export const EXPORT_MAX_ROWS = 1048575;

// ── Recipe document (version 1) ─────────────────────────────────────────────
export interface RecipeColumnRef {
  table: string;
  column: string;
}
export interface RecipeTable {
  name: string;
  columns: { name: string; type: ColumnType }[];
}
export interface RecipeMatch {
  left: RecipeColumnRef;
  right: RecipeColumnRef;
  confidence: number;
  edited: boolean;
}
export type RecipeRule =
  | "whitespace"
  | "case"
  | "category"
  | "duplicate-rows"
  | "outliers";
export interface RecipeCleaning {
  rule: RecipeRule;
  table: string;
  /** Required for every rule except `duplicate-rows`. */
  column?: string;
  /** `category` only. */
  canonical?: string;
  /** `category` only. */
  edited?: boolean;
}
export interface RecipeJoinKey {
  left: RecipeColumnRef;
  right: RecipeColumnRef;
}
export interface Recipe {
  format: typeof RECIPE_FORMAT;
  version: typeof RECIPE_VERSION;
  createdAt: string;
  tables: RecipeTable[];
  matches: RecipeMatch[];
  cleanings: RecipeCleaning[];
  join: { anchor: string; keys: RecipeJoinKey[] };
}

// ── Validation ──────────────────────────────────────────────────────────────
export interface RecipeIssue {
  /** A JSON path such as `$.matches[0].left.table`. */
  path: string;
  message: string;
}
export type ValidationResult =
  | { ok: true; recipe: Recipe }
  | { ok: false; errors: RecipeIssue[] };

// ── Mapping ─────────────────────────────────────────────────────────────────
export type NotAppliedCode =
  | "table-not-found"
  | "table-ambiguous"
  | "column-missing"
  | "type-changed"
  | "no-longer-detected"
  | "anchor-unmapped"
  | "key-unmapped";

export interface NotAppliedItem {
  kind: "match" | "cleaning" | "anchor" | "key";
  /** Plain-text description of the recipe item. */
  description: string;
  code: NotAppliedCode;
  /** Plain-text reason. */
  reason: string;
}

export interface RecipeOverrides {
  anchor?: string;
  /** `pairKey(tableA, tableB)` to a match proposal id. */
  joinKeysByPair: Record<string, string>;
}

export interface RecipeMapping {
  /** The current proposals plus any recipe-built matches. */
  proposals: ProposalSet;
  decisions: ApprovalDecision[];
  overrides: RecipeOverrides;
  notApplied: NotAppliedItem[];
  /** Matches and cleanings that received a decision. */
  mappedCount: number;
  /** Recipe table name to loaded table name. */
  tableMap: Record<string, string>;
}

export type ExportFormat = "csv" | "xlsx" | "parquet";
