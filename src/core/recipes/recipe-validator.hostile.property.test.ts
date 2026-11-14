/**
 * Feature: frankendata-recipes, Property 3: Hostile recipes are rejected with
 * no side effects.
 *
 * For any input (arbitrary JSON, arbitrary text, mutated valid recipes), the
 * validator returns a result without throwing, and rejecting a recipe through
 * applyRecipeText changes nothing in the StitchStore.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { StitchStore } from "../stitching/stitch-store";
import { applyRecipeText } from "./recipe-apply";
import { validateRecipeText, validateRecipeValue } from "./recipe-validator";
import { EXPERIMENTS, MONSTERS, proposalSet, validRecipe } from "./recipe-test-support";

function mutateAt(root: unknown, picks: number[], replacement: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(root));
  let node: any = copy;
  for (const p of picks) {
    const keys = node && typeof node === "object" ? Object.keys(node) : [];
    if (keys.length === 0) break;
    const k = keys[p % keys.length];
    if (node[k] && typeof node[k] === "object") node = node[k];
    else {
      node[k] = replacement;
      return copy;
    }
  }
  if (node && typeof node === "object") node.injected = replacement;
  return copy;
}

describe("Feature: frankendata-recipes, Property 3: hostile recipes", () => {
  it("never throws for arbitrary JSON values or text", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.string({ unit: "binary" }), (v, s) => {
        expect(() => validateRecipeValue(v)).not.toThrow();
        expect(() => validateRecipeText(s)).not.toThrow();
        expect(() => validateRecipeText(JSON.stringify(v))).not.toThrow();
      }),
      { numRuns: 200 }
    );
  });

  it("rejects every mutated recipe that adds or breaks a field, or accepts only a valid one", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(10), { maxLength: 4 }),
        fc.oneof(fc.jsonValue(), fc.constant("__proto__"), fc.constant("DROP TABLE x; --")),
        (picks, replacement) => {
          const mutated = mutateAt(validRecipe(), picks, replacement);
          const res = validateRecipeValue(mutated);
          if (res.ok) {
            // Anything accepted must re-serialize to a recipe that validates again.
            expect(validateRecipeText(JSON.stringify(res.recipe)).ok).toBe(true);
          } else {
            expect(res.errors.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("a rejected recipe leaves the StitchStore untouched and computes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "binary" }), async (garbage) => {
        const store = new StitchStore();
        store.setProposals(proposalSet(), "v1", false);
        const before = store.getState();
        const compute = vi.fn(async () => proposalSet());
        const selectTables = vi.fn();
        const res = await applyRecipeText(garbage, {
          tables: [MONSTERS, EXPERIMENTS],
          store,
          computeProposals: compute,
          selectTables,
        });
        expect(res.ok).toBe(false);
        expect(store.getState()).toBe(before);
        expect(compute).not.toHaveBeenCalled();
        expect(selectTables).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });
});
