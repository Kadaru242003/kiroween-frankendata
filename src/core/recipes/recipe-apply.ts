/**
 * Recipe application orchestration (Feature 5, Requirement 4.7), kept out of
 * React so it can be tested with a real StitchStore.
 *
 * Order: validate (no side effects on failure) -> map tables -> make the mapped
 * tables part of the stitch selection -> recompute proposals through the
 * existing controller -> map items -> record the augmented proposals and the
 * pre-approved decisions in the existing StitchStore. It never applies a plan.
 */
import type { StitchStore } from "../stitching/stitch-store";
import type { ProposalSet } from "../stitching/types";
import {
  mapRecipeItems,
  mapRecipeTables,
  type MapperTable,
} from "./recipe-mapper";
import { validateRecipeText } from "./recipe-validator";
import type { RecipeIssue, RecipeMapping } from "./types";

export interface ApplyRecipeDeps {
  tables: readonly MapperTable[];
  store: StitchStore;
  /** Called with the mapped loaded table names BEFORE proposals are computed. */
  selectTables?: (mappedLoadedNames: string[]) => void;
  /** The existing `StitchController.computeProposals`. */
  computeProposals: () => Promise<ProposalSet>;
}

export type ApplyRecipeResult =
  | { ok: true; mapping: RecipeMapping }
  | { ok: false; errors: RecipeIssue[] };

export async function applyRecipeText(
  text: string,
  deps: ApplyRecipeDeps
): Promise<ApplyRecipeResult> {
  const validated = validateRecipeText(text);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }
  const recipe = validated.recipe;
  const tableMapping = mapRecipeTables(recipe, deps.tables);
  deps.selectTables?.(Object.values(tableMapping.tableMap));

  let proposals: ProposalSet;
  try {
    proposals = await deps.computeProposals();
  } catch {
    return {
      ok: false,
      errors: [{ path: "$", message: "Could not prepare proposals for the recipe." }],
    };
  }
  const mapping = mapRecipeItems(recipe, deps.tables, tableMapping, proposals);
  deps.store.setProposals(
    mapping.proposals,
    deps.store.getDatasetVersion() ?? "recipe",
    false
  );
  for (const d of mapping.decisions) {
    deps.store.setDecision(d);
  }
  return { ok: true, mapping };
}
