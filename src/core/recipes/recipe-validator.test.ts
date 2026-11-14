import { describe, expect, it } from "vitest";
import { validateRecipeText, validateRecipeValue } from "./recipe-validator";
import { validRecipe } from "./recipe-test-support";
import { RECIPE_MAX_BYTES, RECIPE_MAX_TABLES } from "./types";

const text = (v: unknown) => JSON.stringify(v);
const mutate = (fn: (r: any) => void) => {
  const r = JSON.parse(JSON.stringify(validRecipe()));
  fn(r);
  return r;
};
const errorsOf = (v: unknown) => {
  const res = validateRecipeValue(v);
  return res.ok ? [] : res.errors;
};

describe("validateRecipeText", () => {
  it("accepts a valid recipe and returns a fresh equal object", () => {
    const res = validateRecipeText(text(validRecipe()));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.recipe).toEqual(validRecipe());
  });
  it("rejects oversized text before parsing", () => {
    const res = validateRecipeText("x".repeat(RECIPE_MAX_BYTES + 1));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].message).toMatch(/too large/);
  });
  it("rejects non-JSON and non-object values", () => {
    expect(validateRecipeText("{nope").ok).toBe(false);
    expect(validateRecipeText("[]").ok).toBe(false);
    expect(validateRecipeText("null").ok).toBe(false);
    expect(validateRecipeText("42").ok).toBe(false);
  });
});

describe("validateRecipeValue", () => {
  it("rejects unknown fields at every level", () => {
    expect(errorsOf(mutate((r) => (r.sql = "DROP TABLE x"))).some((e) => e.path === "$.sql")).toBe(true);
    expect(errorsOf(mutate((r) => (r.matches[0].left.extra = 1))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.tables[0].columns[0].extra = 1))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.join.extra = 1))).length).toBeGreaterThan(0);
  });
  it("rejects missing fields and wrong types", () => {
    expect(errorsOf(mutate((r) => delete r.join)).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.matches[0].confidence = "high"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.matches[0].confidence = 1.5))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.matches[0].edited = "no"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.tables[0].columns[0].type = "blob"))).length).toBeGreaterThan(0);
  });
  it("checks format and version, with a distinct newer-version message", () => {
    expect(errorsOf(mutate((r) => (r.format = "other")))[0].path).toBe("$.format");
    expect(errorsOf(mutate((r) => (r.version = 2)))[0].message).toMatch(/newer/);
    expect(errorsOf(mutate((r) => (r.version = 0)))[0].path).toBe("$.version");
  });
  it("rejects a bad timestamp", () => {
    expect(errorsOf(mutate((r) => (r.createdAt = "yesterday")))[0].path).toBe("$.createdAt");
  });
  it("enforces limits", () => {
    const many = mutate((r) => {
      r.tables = Array.from({ length: RECIPE_MAX_TABLES + 1 }, (_, i) => ({ name: `t${i}`, columns: [] }));
    });
    expect(errorsOf(many).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.tables[0].name = "x".repeat(201)))).length).toBeGreaterThan(0);
  });
  it("checks cross references and duplicates", () => {
    expect(errorsOf(mutate((r) => (r.matches[0].left.table = "ghost"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.matches[0].left.column = "ghost"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.join.anchor = "ghost"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.tables[1].name = "monsters"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => r.tables[0].columns.push({ name: "Species", type: "string" }))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.join.keys[0].right.column = "species"))).length).toBeGreaterThan(0);
  });
  it("checks cleaning shape", () => {
    expect(errorsOf(mutate((r) => (r.cleanings[0].rule = "drop"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.cleanings[1].column = "Species"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => delete r.cleanings[0].column)).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.cleanings[1].canonical = "x"))).length).toBeGreaterThan(0);
  });
  it("rejects hostile names and never pollutes prototypes", () => {
    const res = validateRecipeText(
      '{"__proto__":{"polluted":true},"format":"frankendata-recipe","version":1}'
    );
    expect(res.ok).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect(errorsOf(mutate((r) => (r.tables[0].name = "__proto__"))).length).toBeGreaterThan(0);
    expect(errorsOf(mutate((r) => (r.tables[0].columns[0].name = "constructor"))).length).toBeGreaterThan(0);
  });
  it("never throws on odd values", () => {
    for (const v of [undefined, null, 1, "s", [], {}, () => 1, Symbol("x"), 10n]) {
      expect(() => validateRecipeValue(v)).not.toThrow();
      expect(validateRecipeValue(v).ok).toBe(false);
    }
  });
});
