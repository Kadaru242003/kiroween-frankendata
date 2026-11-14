/**
 * Recipe builder (Feature 5, Requirement 2): turns an applied StitchPlan into a
 * Recipe. Pure and deterministic apart from the injected `now`. It copies only
 * table and column NAMES and TYPES, never any row value.
 */
import type {
  ApprovalDecision,
  StitchPlan,
} from "../stitching/types";
import type { LoadedTable } from "../types";
import { matchIdFor, ruleOf } from "./recipe-ids";
import { RECIPE_FORMAT, RECIPE_VERSION } from "./types";
import type {
  Recipe,
  RecipeCleaning,
  RecipeJoinKey,
  RecipeMatch,
  RecipeTable,
} from "./types";

export interface BuildRecipeInput {
  plan: StitchPlan;
  /** The loaded tables (only those the plan refers to are described). */
  tables: readonly Pick<LoadedTable, "tableName" | "schema">[];
  /** The user's decisions, used only to flag edited matches and canonicals. */
  decisions?: Readonly<Record<string, ApprovalDecision>>;
  now: Date;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Build a Recipe from the applied plan (Requirement 2.2 to 2.7). */
export function buildRecipe(input: BuildRecipeInput): Recipe {
  const { plan, tables, decisions = {}, now } = input;

  const referenced = new Set<string>();
  if (plan.anchorTableName) referenced.add(plan.anchorTableName);
  for (const m of plan.approvedMatches) {
    referenced.add(m.left.tableName);
    referenced.add(m.right.tableName);
  }
  for (const c of plan.approvedCleanings) referenced.add(c.target.tableName);

  const recipeTables: RecipeTable[] = tables
    .filter((t) => referenced.has(t.tableName))
    .map((t) => ({
      name: t.tableName,
      columns: t.schema.map((c) => ({ name: c.name, type: c.type })),
    }))
    .sort((a, b) => cmp(a.name, b.name));

  const matches: RecipeMatch[] = plan.approvedMatches
    .map((m) => ({
      left: { table: m.left.tableName, column: m.left.columnName },
      right: { table: m.right.tableName, column: m.right.columnName },
      confidence: clamp01(m.confidence),
      edited: decisions[m.id]?.decision === "edited",
    }))
    .sort((a, b) => cmp(matchIdFor(a.left, a.right), matchIdFor(b.left, b.right)));

  const cleanings: RecipeCleaning[] = plan.approvedCleanings
    .map((c) => {
      const rule = ruleOf(c);
      const out: RecipeCleaning = { rule, table: c.target.tableName };
      if (rule !== "duplicate-rows" && c.target.columnName !== undefined) {
        out.column = c.target.columnName;
      }
      if (rule === "category") {
        if (c.canonical !== undefined) out.canonical = c.canonical;
        const d = decisions[c.id];
        out.edited =
          d?.decision === "edited" &&
          (d.edit as { canonical?: string } | undefined)?.canonical !== undefined;
      }
      return out;
    })
    .sort(
      (a, b) =>
        cmp(a.rule, b.rule) || cmp(a.table, b.table) || cmp(a.column ?? "", b.column ?? "")
    );

  const matchById = new Map(plan.approvedMatches.map((m) => [m.id, m]));
  const keys: RecipeJoinKey[] = [];
  const seen = new Set<string>();
  for (const matchId of Object.values(plan.joinKeysByPair)) {
    const m = matchById.get(matchId);
    if (!m) continue;
    const key: RecipeJoinKey = {
      left: { table: m.left.tableName, column: m.left.columnName },
      right: { table: m.right.tableName, column: m.right.columnName },
    };
    const id = matchIdFor(key.left, key.right);
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(key);
  }
  keys.sort((a, b) => cmp(matchIdFor(a.left, a.right), matchIdFor(b.left, b.right)));

  return {
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    createdAt: now.toISOString(),
    tables: recipeTables,
    matches,
    cleanings,
    join: { anchor: plan.anchorTableName, keys },
  };
}

/** Serialize a recipe as readable JSON text ending in a newline. */
export function serializeRecipe(recipe: Recipe): string {
  return `${JSON.stringify(recipe, null, 2)}\n`;
}

/** `frankendata-recipe-<yyyy-mm-dd>.json` (Requirement 2.8). */
export function recipeFileName(date: Date): string {
  return `frankendata-recipe-${date.toISOString().slice(0, 10)}.json`;
}
