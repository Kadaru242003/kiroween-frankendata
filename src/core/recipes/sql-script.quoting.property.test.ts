/**
 * Feature: frankendata-recipes, Property 5: SQL script quoting.
 * For any table and column names, including adversarial ones, every identifier
 * in the script is quoted, and no name creates a statement boundary: a
 * quote-aware tokenizer finds exactly the statements the builder emitted.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { quoteIdent } from "../stitching/sql-escape";
import type { MatchProposal, StitchPlan } from "../stitching/types";
import { buildSqlScript } from "./sql-script";
import { tokenizeScript } from "./sql-script-tokenizer";

const adversarial = fc.oneof(
  fc.string({ unit: "binary", minLength: 1, maxLength: 12 }),
  fc.constantFrom(
    'a"; DROP TABLE x; --',
    "it's",
    "x\nSELECT 1;",
    "--",
    "/* c */",
    "SELECT",
    "a;b",
    '"',
    "'"
  )
);

describe("Feature: frankendata-recipes, Property 5: SQL script quoting", () => {
  it("quotes every identifier and never lets a name break out", () => {
    fc.assert(
      fc.property(
        adversarial,
        adversarial,
        adversarial,
        adversarial,
        adversarial,
        (t1, t2, c1, c2, c3) => {
          fc.pre(t1 !== t2 && c1 !== c2);
          const tables = [
            { tableName: t1, sourceFileName: `${t1}.csv`, rowCount: 5,
              schema: [{ name: c1, type: "string" as const }, { name: c3, type: "number" as const }] },
            { tableName: t2, sourceFileName: `${t2}.csv`, rowCount: 3,
              schema: [{ name: c2, type: "string" as const }] },
          ];
          const m: MatchProposal = {
            id: "m1",
            left: { tableName: t1, columnName: c1, type: "string" },
            right: { tableName: t2, columnName: c2, type: "string" },
            confidence: 0.9, reason: "r", source: "rules",
            components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
          };
          const plan: StitchPlan = {
            anchorTableName: t1,
            joinKeysByPair: {},
            approvedMatches: [m],
            approvedCleanings: [
              { id: "d", target: { tableName: t1 }, kind: "duplicate-rows", before: 1, after: 1, reason: "r" },
              { id: "w", target: { tableName: t1, columnName: c1 }, kind: "whitespace-case", before: "a", after: "b", reason: "r" },
            ],
          };
          const script = buildSqlScript({ plan, tables, now: new Date(0) });
          const { statements, codeOnly } = tokenizeScript(script);
          // 2 loads x 2 statements + 1 cleaned copy x 2 + 1 result.
          expect(statements).toHaveLength(7);
          for (const name of [t1, t2, c1, c2, c3]) {
            expect(script).toContain(quoteIdent(name));
          }
          // With quotes and comments removed, only SQL syntax characters remain.
          expect(codeOnly).toMatch(/^[A-Za-z0-9_\s(),.=;[\]*<>+\-]*$/);
        }
      ),
      { numRuns: 150 }
    );
  });
});
