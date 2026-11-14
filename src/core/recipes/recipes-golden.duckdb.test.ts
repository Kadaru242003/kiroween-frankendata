/**
 * Golden DuckDB test for Recipes (Feature 5): stitch month one, save a recipe,
 * reset the lab, load next month's files, apply the recipe, and pin the result.
 * Also: the same-tables equivalence (Property 2) and the SQL script reproducing
 * the stitched result when run in DuckDB over the same CSV text.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoDataLoader } from "../demo-data-loader";
import { assembleStitchPlan } from "../stitching/plan-assembly";
import { buildRecipe, serializeRecipe } from "./recipe-builder";
import { applyRecipeText } from "./recipe-apply";
import { applyRecipeOverrides } from "./recipe-mapper";
import { loadNextMonthFiles } from "./next-month-demo";
import { createTestLab, resultSnapshot, type TestLab } from "./recipe-test-lab";
import { buildSqlScript } from "./sql-script";
import { tokenizeScript } from "./sql-script-tokenizer";
import { createTestDuckDB } from "./duckdb-test-harness";
import type { ApprovalDecision, StitchPlan } from "../stitching/types";

const NOW = new Date("2026-11-11T10:00:00.000Z");

/** The flow the app follows after a recipe is applied and the user confirms. */
function confirmedPlan(lab: TestLab, overrides: Parameters<typeof applyRecipeOverrides>[1]): StitchPlan {
  const state = lab.stitchStore.getState();
  const plan = assembleStitchPlan(state.proposals!, state.decisions as Record<string, ApprovalDecision>, lab.tables());
  return applyRecipeOverrides(plan, overrides, lab.tables().map((t) => t.tableName));
}

describe("Recipes golden: month one to month two", () => {
  let lab: TestLab;
  let recipeText = "";
  let monthOne: { columns: string[]; rows: string[]; table: string };
  let monthOnePlan: StitchPlan;
  let monthOneTables: ReturnType<TestLab["tables"]>;

  beforeAll(async () => {
    lab = await createTestLab();
    await lab.load(await demoDataLoader.loadMismatched());
    const { plan, decisions } = await lab.approveAllPlan();
    monthOnePlan = plan;
    monthOneTables = lab.tables();
    const stitched = await lab.controller.applyPlan(plan);
    monthOne = { ...(await resultSnapshot(lab.db, stitched.tableName)), table: stitched.tableName };
    recipeText = serializeRecipe(
      buildRecipe({ plan, tables: lab.tables(), decisions, now: NOW })
    );
  });
  afterAll(() => lab.dispose());

  it("month one stitches the expected result", () => {
    expect(monthOne.table).toBe("stitch_1_result");
    expect(monthOne.rows.length).toBeGreaterThan(0);
  });

  it("the saved recipe has no row values", () => {
    const recipe = JSON.parse(recipeText);
    expect(Object.keys(recipe).sort()).toEqual(
      ["cleanings", "createdAt", "format", "join", "matches", "tables", "version"]
    );
    expect(recipeText).not.toContain("Gorzak");
    expect(recipeText).not.toContain("Swamp Wraith\"");
  });

  it("Property 2: applying the recipe to the SAME tables reproduces an identical result", async () => {
    await lab.controller.undo();
    const res = await applyRecipeText(recipeText, {
      tables: lab.tables(),
      store: lab.stitchStore,
      computeProposals: () => lab.controller.computeProposals(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mapping.notApplied).toEqual([]);
    const plan = confirmedPlan(lab, res.mapping.overrides);
    const stitched = await lab.controller.applyPlan(plan);
    const again = await resultSnapshot(lab.db, stitched.tableName);
    expect(again.columns).toEqual(monthOne.columns);
    expect(again.rows).toEqual(monthOne.rows);
    expect(plan.anchorTableName).toBe(monthOnePlan.anchorTableName);
    await lab.controller.undo();
  });

  it("the SQL script reproduces the stitched result when run in DuckDB", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frankendata-script-"));
    try {
      for (const f of await demoDataLoader.loadMismatched()) {
        fs.writeFileSync(path.join(dir, f.name), await f.text());
      }
      const script = buildSqlScript({ plan: monthOnePlan, tables: monthOneTables, now: NOW })
        .split("'/path/to/").join(`'${dir}/`);
      const other = await createTestDuckDB();
      try {
        for (const stmt of tokenizeScript(script).statements) {
          await other.service.query(stmt);
        }
        const fromScript = await resultSnapshot(other.service, "stitch_1_result");
        expect(fromScript.columns).toEqual(monthOne.columns);
        expect(fromScript.rows).toEqual(monthOne.rows);
      } finally {
        other.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("next month: reset, load new files, apply the recipe, pin the result", async () => {
    await lab.reset();
    expect(lab.tables()).toHaveLength(0);
    await lab.load(await loadNextMonthFiles());
    const res = await applyRecipeText(recipeText, {
      tables: lab.tables(),
      store: lab.stitchStore,
      computeProposals: () => lab.controller.computeProposals(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const summary = {
      mapped: res.mapping.mappedCount,
      notApplied: res.mapping.notApplied.map((n) => `${n.kind}:${n.code}`),
      approved: Object.keys(lab.stitchStore.getState().decisions).length,
    };
    const plan = confirmedPlan(lab, res.mapping.overrides);
    const stitched = await lab.controller.applyPlan(plan);
    const snap = await resultSnapshot(lab.db, stitched.tableName);
    // Pinned month-two result (regression anchor).
    expect(summary).toEqual({ mapped: 9, notApplied: [], approved: 9 });
    expect(plan.anchorTableName).toBe("monsters");
    expect(plan.approvedMatches).toHaveLength(2);
    expect(plan.approvedCleanings.map((c) => c.id).sort()).toEqual([
      "clean:case:experiments.species",
      "clean:case:monsters.Species",
      "clean:category:experiments.species",
      "clean:category:monsters.Species",
      "clean:duplicate-rows:experiments",
      "clean:duplicate-rows:monsters",
      "clean:whitespace:monsters.Species",
    ]);
    expect(snap.columns).toEqual([
      "Monster_Name", "Species", "Threat_Level", "Sedated", "species_1", "danger_level", "hazardous",
    ]);
    // 14 roster rows minus the 2 extra Sorrow duplicates.
    expect(snap.rows).toHaveLength(12);
    expect(snap.rows).toEqual(
      [
        ["Bogsworth", "BOG HAG", "High", "true", "Bog Hag", "High", "true"],
        ["Dross", "Three-Eyed Ooze", "Medium", "false", "three-eyed ooze", "Medium", "true"],
        ["Ember", "Moth Titan", "High", "false", "Moth Titan", "High", "true"],
        ["Gloam", "Swamp Wraith", "Medium", "true", "Swamp Wraith", "Medium", "false"],
        ["Hollow", "Moth Titan", "High", "true", "Moth Titan", "High", "false"],
        ["Murk", "Swamp Wraith", "Low", "false", "Swamp Wraith", "Low", "true"],
        ["Nettle", "BOG HAG", "High", "false", "Bog Hag", "High", "true"],
        ["Pinch", "BOG HAG", "Low", "false", "Bog Hag", "Low", "true"],
        ["Quill", "Cave Howler", "Medium", "false", "Cave Howler", "Medium", "false"],
        ["Rattle", "Bone Shambler", "Low", "true", "Bone Shambler", "Low", "false"],
        ["Skrill", "Rock Golem", "Medium", "true", "Rock Golem", "Medium", "false"],
        ["Sorrow", "Cave Howler", "High", "true", "Cave Howler", "High", "false"],
      ]
        .map((r) => JSON.stringify(r))
        .sort()
    );
  });
});
