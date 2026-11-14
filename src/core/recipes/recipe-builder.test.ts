import { describe, expect, it } from "vitest";
import { buildRecipe, recipeFileName, serializeRecipe } from "./recipe-builder";
import { validateRecipeText } from "./recipe-validator";
import { EXPERIMENTS, MONSTERS, NAME_MATCH, planOf, SPECIES_CATEGORY } from "./recipe-test-support";

const now = new Date("2026-11-11T10:00:00.000Z");
const LAB = { ...MONSTERS, tableName: "lab_inventory" };

describe("buildRecipe", () => {
  it("describes only tables the plan uses, with names and types only", () => {
    const r = buildRecipe({ plan: planOf(), tables: [MONSTERS, EXPERIMENTS, LAB], now });
    expect(r.tables.map((t) => t.name)).toEqual(["experiments", "monsters"]);
    expect(JSON.stringify(r)).not.toMatch(/\.csv/);
    expect(r.join.anchor).toBe("monsters");
    expect(r.join.keys).toHaveLength(1);
    expect(r.matches[0].confidence).toBe(0.95);
    expect(r.createdAt).toBe(now.toISOString());
  });
  it("contains exactly the plan's matches and cleanings and passes the validator", () => {
    const r = buildRecipe({ plan: planOf(), tables: [MONSTERS, EXPERIMENTS], now });
    expect(r.matches).toHaveLength(1);
    expect(r.cleanings.map((c) => c.rule).sort()).toEqual(["category", "duplicate-rows"]);
    expect(r.cleanings.find((c) => c.rule === "category")).toMatchObject({
      column: "Species",
      canonical: "Swamp Wraith",
      edited: false,
    });
    expect(validateRecipeText(serializeRecipe(r)).ok).toBe(true);
  });
  it("flags edited matches and canonicals from decisions", () => {
    const r = buildRecipe({
      plan: planOf(),
      tables: [MONSTERS, EXPERIMENTS],
      decisions: {
        [NAME_MATCH.id]: { proposalId: NAME_MATCH.id, decision: "edited" },
        [SPECIES_CATEGORY.id]: {
          proposalId: SPECIES_CATEGORY.id,
          decision: "edited",
          edit: { canonical: "Wraith" },
        },
      },
      now,
    });
    expect(r.matches[0].edited).toBe(true);
    expect(r.cleanings.find((c) => c.rule === "category")?.edited).toBe(true);
  });
  it("is deterministic and drops keys whose match is missing", () => {
    const plan = { ...planOf(), joinKeysByPair: { "a|b": "match:missing" } };
    const a = serializeRecipe(buildRecipe({ plan, tables: [MONSTERS, EXPERIMENTS], now }));
    const b = serializeRecipe(buildRecipe({ plan, tables: [MONSTERS, EXPERIMENTS], now }));
    expect(a).toBe(b);
    expect(JSON.parse(a).join.keys).toEqual([]);
  });
  it("names the file from the date", () => {
    expect(recipeFileName(now)).toBe("frankendata-recipe-2026-11-11.json");
  });
});
