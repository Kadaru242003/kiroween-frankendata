/**
 * Identity helpers shared by the recipe builder and mapper (Feature 5).
 *
 * A recipe stores rules and column references, never proposal ids. These
 * helpers derive the EXISTING proposal ids (see `cleaning-rules.ts` and
 * `match-scoring.ts`) from validated names, so a recipe maps onto the existing
 * proposal types.
 */
import { pairId } from "../stitching/match-scoring";
import type { CleaningProposal } from "../stitching/types";
import type { RecipeColumnRef, RecipeRule } from "./types";

/** The existing cleaning proposal id for a rule on a table (and column). */
export function cleaningIdFor(
  rule: RecipeRule,
  table: string,
  column?: string
): string {
  if (rule === "duplicate-rows") {
    return `clean:duplicate-rows:${table}`;
  }
  return `clean:${rule}:${table}.${column ?? ""}`;
}

/** The recipe rule an existing cleaning proposal corresponds to. */
export function ruleOf(proposal: CleaningProposal): RecipeRule {
  switch (proposal.kind) {
    case "whitespace-case":
      return proposal.variantMap ? "case" : "whitespace";
    case "category-standardize":
      return "category";
    case "duplicate-rows":
      return "duplicate-rows";
    case "outliers":
      return "outliers";
  }
}

/** The existing match proposal id for an unordered pair of column refs. */
export function matchIdFor(a: RecipeColumnRef, b: RecipeColumnRef): string {
  return pairId(
    { tableName: a.table, columnName: a.column, type: "string" },
    { tableName: b.table, columnName: b.column, type: "string" }
  );
}
