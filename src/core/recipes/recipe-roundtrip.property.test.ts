/**
 * Feature: frankendata-recipes, Property 1: Recipe round trip.
 *
 * For any plan assembled from approved proposals, building a recipe,
 * serializing it, validating it, and mapping it onto the same tables and the
 * same proposals yields an equivalent plan: same approved match pairs, same
 * approved cleanings (rule, table, column), same anchor, same join keys.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assembleStitchPlan } from "../stitching/plan-assembly";
import type {
  ApprovalDecision,
  CleaningProposal,
  MatchProposal,
  ProposalSet,
  StitchPlan,
} from "../stitching/types";
import { buildRecipe, serializeRecipe } from "./recipe-builder";
import { matchIdFor, ruleOf } from "./recipe-ids";
import { assemblePlanFromMapping, mapRecipe } from "./recipe-mapper";
import { validateRecipeText } from "./recipe-validator";
import { cleaning, match, table } from "./recipe-test-support";

const TYPES = ["string", "number"] as const;

const scenario = fc
  .record({
    tableCount: fc.integer({ min: 2, max: 3 }),
    colCounts: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 3, maxLength: 3 }),
    types: fc.array(fc.constantFrom(...TYPES), { minLength: 12, maxLength: 12 }),
    matchPicks: fc.array(
      fc.record({
        a: fc.nat(2), ac: fc.nat(3), b: fc.nat(2), bc: fc.nat(3),
        conf: fc.integer({ min: 50, max: 100 }), approve: fc.boolean(),
      }),
      { maxLength: 6 }
    ),
    cleanPicks: fc.array(
      fc.record({
        t: fc.nat(2), c: fc.nat(3), kind: fc.constantFrom("ws", "case", "cat", "dup", "out"),
        approve: fc.boolean(),
      }),
      { maxLength: 8 }
    ),
    anchor: fc.nat(2),
  });

describe("Feature: frankendata-recipes, Property 1: recipe round trip", () => {
  it("builds, serializes, validates, and maps back to an equivalent plan", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const tables = Array.from({ length: s.tableCount }, (_, i) =>
          table(
            `t${i}`,
            Array.from({ length: s.colCounts[i] }, (_, j) => ({
              name: `c${j}`,
              type: s.types[i * 4 + j],
            })),
            10 + i,
            i + 1
          )
        );
        const matches = new Map<string, MatchProposal>();
        const decisions: Record<string, ApprovalDecision> = {};
        for (const p of s.matchPicks) {
          const a = p.a % s.tableCount;
          const b = p.b % s.tableCount;
          if (a === b) continue;
          const ac = `c${p.ac % s.colCounts[a]}`;
          const bc = `c${p.bc % s.colCounts[b]}`;
          const m = match(`t${a}`, ac, `t${b}`, bc, p.conf / 100);
          if (matches.has(m.id)) continue;
          matches.set(m.id, m);
          if (p.approve) decisions[m.id] = { proposalId: m.id, decision: "approved" };
        }
        const cleanings = new Map<string, CleaningProposal>();
        for (const p of s.cleanPicks) {
          const t = p.t % s.tableCount;
          const col = tables[t].schema[p.c % s.colCounts[t]];
          const c =
            p.kind === "dup"
              ? cleaning("duplicate-rows", `t${t}`)
              : p.kind === "out"
                ? cleaning("outliers", `t${t}`, col.name)
                : p.kind === "cat"
                  ? cleaning("category-standardize", `t${t}`, col.name, { canonical: "X", variantMap: { x: "X" } })
                  : p.kind === "case"
                    ? cleaning("whitespace-case", `t${t}`, col.name, { variantMap: { a: "A" } })
                    : cleaning("whitespace-case", `t${t}`, col.name);
          if (cleanings.has(c.id)) continue;
          cleanings.set(c.id, c);
          if (p.approve) decisions[c.id] = { proposalId: c.id, decision: "approved" };
        }
        const proposals: ProposalSet = {
          matches: [...matches.values()],
          cleanings: [...cleanings.values()],
          aiUsed: false,
        };
        const plan = assembleStitchPlan(proposals, decisions, tables, {
          anchorTableName: `t${s.anchor % s.tableCount}`,
        });

        const recipe = buildRecipe({ plan, tables, decisions, now: new Date(0) });
        const validated = validateRecipeText(serializeRecipe(recipe));
        expect(validated.ok).toBe(true);
        if (!validated.ok) return;
        const mapping = mapRecipe(validated.recipe, tables, proposals);
        expect(mapping.notApplied).toEqual([]);
        const back = assemblePlanFromMapping(mapping, tables);

        expect(normalize(back)).toEqual(normalize(plan));
      }),
      { numRuns: 150 }
    );
  });
});

function normalize(plan: StitchPlan) {
  const byId = new Map(plan.approvedMatches.map((m) => [m.id, m]));
  const pair = (m: MatchProposal) =>
    matchIdFor(
      { table: m.left.tableName, column: m.left.columnName },
      { table: m.right.tableName, column: m.right.columnName }
    );
  return {
    anchor: plan.anchorTableName,
    matches: plan.approvedMatches.map(pair).sort(),
    cleanings: plan.approvedCleanings
      .map((c) => `${ruleOf(c)}:${c.target.tableName}:${c.target.columnName ?? ""}`)
      .sort(),
    keys: Object.entries(plan.joinKeysByPair)
      .map(([k, id]) => `${k}=>${byId.has(id) ? pair(byId.get(id)!) : "?"}`)
      .sort(),
  };
}
