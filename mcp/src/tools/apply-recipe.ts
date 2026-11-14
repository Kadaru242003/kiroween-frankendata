/** frankendata_apply_recipe (Requirement 7). */
import * as fs from "node:fs/promises";
import { z } from "zod";
import { applyRecipeText } from "../../../src/core/recipes/recipe-apply";
import { applyRecipeOverrides } from "../../../src/core/recipes/recipe-mapper";
import { RECIPE_MAX_BYTES } from "../../../src/core/recipes/types";
import { assembleStitchPlan } from "../../../src/core/stitching/plan-assembly";
import { toolError } from "../errors";
import { okResult, type ToolResult } from "../results";
import type { Session } from "../session";
import { applyPlanAndDescribe } from "./apply-stitch";

export const applyRecipeShape = {
  path: z.string().describe("Path of a saved FrankenData recipe .json inside the allowed root."),
};

export async function applyRecipe(session: Session, args: { path: string }): Promise<ToolResult> {
  return session.run(async () => {
    const guard = await session.guard();
    const real = await guard.resolveInput(args.path);
    const stat = await fs.stat(real);
    if (stat.size > RECIPE_MAX_BYTES) {
      throw toolError("invalid-recipe", "The recipe file is too large.");
    }
    const text = await fs.readFile(real, "utf8");
    const tables = session.tables();
    if (tables.length === 0) {
      throw toolError("table-not-found", "No tables are loaded. Call frankendata_load_files first.");
    }
    const controller = await session.stitchController();
    session.selection.names = null;
    const result = await applyRecipeText(text, {
      tables,
      store: session.stitchStore,
      computeProposals: () => controller.computeProposals(),
    });
    if (!result.ok) {
      const issues = result.errors
        .slice(0, 5)
        .map((e) => `${e.path} ${e.message}`)
        .join("; ");
      throw toolError("invalid-recipe", `The recipe was rejected: ${issues}`);
    }
    const state = session.stitchStore.getState();
    const plan = applyRecipeOverrides(
      assembleStitchPlan(state.proposals!, state.decisions, tables),
      result.mapping.overrides,
      tables.map((t) => t.tableName)
    );
    const applied = await applyPlanAndDescribe(session, plan);
    return okResult({
      ...applied,
      preApproved: result.mapping.mappedCount,
      notApplied: result.mapping.notApplied,
      tableMap: result.mapping.tableMap,
    });
  });
}
