import { describe, expect, it } from "vitest";
import {
  applyRecipeOverrides,
  assemblePlanFromMapping,
  mapRecipe,
  mapRecipeTables,
} from "./recipe-mapper";
import {
  cleaning,
  EXPERIMENTS,
  match,
  MONSTERS,
  NAME_MATCH,
  proposalSet,
  table,
  validRecipe,
} from "./recipe-test-support";

const loaded = [MONSTERS, EXPERIMENTS];

describe("mapRecipeTables", () => {
  it("maps by name first", () => {
    const m = mapRecipeTables(validRecipe(), loaded);
    expect(m.tableMap).toEqual({ monsters: "monsters", experiments: "experiments" });
  });
  it("maps a renamed table by identical column schema when unique", () => {
    const renamed = { ...EXPERIMENTS, tableName: "experiments_2" };
    const m = mapRecipeTables(validRecipe(), [MONSTERS, renamed]);
    expect(m.tableMap.experiments).toBe("experiments_2");
  });
  it("reports ambiguous and missing tables", () => {
    const a = { ...EXPERIMENTS, tableName: "e1" };
    const b = { ...EXPERIMENTS, tableName: "e2" };
    expect(mapRecipeTables(validRecipe(), [MONSTERS, a, b]).unmapped.experiments.code).toBe("table-ambiguous");
    expect(mapRecipeTables(validRecipe(), [MONSTERS]).unmapped.experiments.code).toBe("table-not-found");
  });
});

describe("mapRecipe", () => {
  it("pre-approves matches, cleanings, anchor and keys with nothing dropped", () => {
    const res = mapRecipe(validRecipe(), loaded, proposalSet());
    expect(res.notApplied).toEqual([]);
    expect(res.mappedCount).toBe(3);
    expect(res.decisions.every((d) => d.decision === "approved")).toBe(true);
    expect(res.overrides.anchor).toBe("monsters");
    expect(Object.values(res.overrides.joinKeysByPair)).toEqual([NAME_MATCH.id]);
  });
  it("builds a recipe match that is not in the current proposals", () => {
    const empty = { ...proposalSet(), matches: [] };
    const res = mapRecipe(validRecipe(), loaded, empty);
    expect(res.proposals.matches).toHaveLength(1);
    expect(res.proposals.matches[0]).toMatchObject({ reason: "From recipe", source: "rules", confidence: 0.95 });
    expect(res.decisions[0]).toEqual({ proposalId: NAME_MATCH.id, decision: "approved" });
  });
  it("lists a cleanup that is no longer detected", () => {
    const none = { ...proposalSet(), cleanings: [] };
    const res = mapRecipe(validRecipe(), loaded, none);
    expect(res.notApplied.map((n) => n.code)).toEqual(["no-longer-detected", "no-longer-detected"]);
    expect(res.mappedCount).toBe(1);
  });
  it("lists missing columns and changed types", () => {
    const noSpecies = table("monsters", MONSTERS.schema.filter((c) => c.name !== "Species"));
    const r1 = mapRecipe(validRecipe(), [noSpecies, EXPERIMENTS], proposalSet());
    expect(r1.notApplied.some((n) => n.code === "column-missing" && n.kind === "cleaning")).toBe(true);
    const retyped = table("experiments", EXPERIMENTS.schema.map((c) => (c.name === "monster_name" ? { ...c, type: "number" as const } : c)));
    const r2 = mapRecipe(validRecipe(), [MONSTERS, retyped], proposalSet());
    expect(r2.notApplied.some((n) => n.code === "type-changed" && n.kind === "match")).toBe(true);
    expect(r2.notApplied.some((n) => n.kind === "key" && n.code === "key-unmapped")).toBe(true);
  });
  it("lists everything as not applied when no table is loaded", () => {
    const res = mapRecipe(validRecipe(), [], proposalSet());
    expect(res.decisions).toEqual([]);
    expect(res.notApplied.map((n) => n.kind)).toEqual(["match", "cleaning", "cleaning", "anchor", "key"]);
    expect(res.notApplied.find((n) => n.kind === "anchor")?.code).toBe("anchor-unmapped");
  });
  it("records an edited category canonical as an edited decision", () => {
    const r = validRecipe();
    r.cleanings[0] = { ...r.cleanings[0], canonical: "Wraith", edited: true };
    const res = mapRecipe(r, loaded, proposalSet());
    const d = res.decisions.find((x) => x.proposalId.startsWith("clean:category"));
    expect(d).toMatchObject({ decision: "edited", edit: { canonical: "Wraith" } });
  });
  it("re-pairs an edited match from the proposal sharing one endpoint", () => {
    const r = validRecipe();
    r.matches[0] = {
      left: { table: "monsters", column: "Monster_Name" },
      right: { table: "experiments", column: "species" },
      confidence: 0.6,
      edited: true,
    };
    r.join.keys[0] = { left: r.matches[0].left, right: r.matches[0].right };
    const res = mapRecipe(r, loaded, proposalSet());
    const d = res.decisions[0];
    expect(d.proposalId).toBe(NAME_MATCH.id);
    expect(d.decision).toBe("edited");
    const plan = assemblePlanFromMapping(res, loaded);
    expect(plan.approvedMatches[0].right.columnName).toBe("species");
    expect(Object.values(plan.joinKeysByPair)).toEqual([plan.approvedMatches[0].id]);
  });
  it("does not touch its inputs", () => {
    const props = proposalSet();
    const snapshot = JSON.stringify(props);
    mapRecipe(validRecipe(), loaded, props);
    expect(JSON.stringify(props)).toBe(snapshot);
  });
});

describe("applyRecipeOverrides", () => {
  it("sets the anchor and keys only when valid", () => {
    const plan = assemblePlanFromMapping(mapRecipe(validRecipe(), loaded, proposalSet()), [
      { tableName: "experiments", rowCount: 99 },
      { tableName: "monsters", rowCount: 1 },
    ]);
    expect(plan.anchorTableName).toBe("monsters");
    const bad = applyRecipeOverrides(
      plan,
      { anchor: "ghost", joinKeysByPair: { "a|b": "match:ghost" } },
      ["monsters"]
    );
    expect(bad.anchorTableName).toBe("monsters");
    expect(bad.joinKeysByPair["a|b"]).toBeUndefined();
    void cleaning; void match;
  });
});
