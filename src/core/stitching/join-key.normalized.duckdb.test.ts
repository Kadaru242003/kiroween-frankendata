/**
 * Text join keys compare normalized values (lower, trim, collapsed whitespace)
 * on both sides, and the fan-out check measures the same join. Display values
 * stay as written, and the anchor side wins in a merged column.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestLab, type TestLab } from "../recipes/recipe-test-lab";
import { assembleStitchPlan } from "./plan-assembly";
import { buildJoinChainSql } from "./stitch-applier";
import type { ApprovalDecision, MatchProposal } from "./types";

const csv = (name: string, text: string) => new File([text], name, { type: "text/csv" });

let lab: TestLab;
beforeAll(async () => {
  lab = await createTestLab();
  // a.k "Ab" matches b.k "ab" and " AB " once normalized: the left row is joined twice.
  await lab.load([csv("a.csv", "k,x\nAb,1\nzed,2\n"), csv("b.csv", "k,v\nab,10\n AB ,20\nother,30\n")]);
}, 120000);
afterAll(() => lab.dispose());

describe("case-insensitive text join keys", () => {
  it("joins on normalized values, keeps display values, and detects the fan-out on the same key", async () => {
    const proposals = await lab.controller.computeProposals();
    const decisions: Record<string, ApprovalDecision> = {};
    for (const m of proposals.matches) decisions[m.id] = { proposalId: m.id, decision: "approved" };
    // Matches only: no cleanups, so the raw values reach the join as written.
    const plan = assembleStitchPlan(proposals, decisions, lab.tables(), { anchorTableName: "a" });
    expect(plan.approvedMatches.length).toBeGreaterThan(0);
    const stitched = await lab.controller.applyPlan(plan);

    const rows = await lab.db.query<Record<string, unknown>>(
      `SELECT k, x, v FROM ${stitched.tableName} ORDER BY x, v`
    );
    expect(rows.map((r) => [r.k, Number(r.x), r.v === null ? null : Number(r.v)])).toEqual([
      ["Ab", 1, 10],
      ["Ab", 1, 20],
      ["zed", 2, null],
    ]);
    expect(lab.stitchStore.getState().fanOut).toEqual({
      anchorRowCount: 2,
      resultRowCount: 3,
      fannedOut: true,
    });
  }, 120000);
});

describe("the shared join builder", () => {
  const m = (left: string, right: string): MatchProposal => ({
    id: `match:a.${left}=b.${right}`,
    left: { tableName: "a", columnName: left, type: "string" },
    right: { tableName: "b", columnName: right, type: "string" },
    confidence: 0.9,
    reason: "",
    source: "rules",
    components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
  });
  const tables = (typeA: "string" | "number", typeB: "string" | "number") => [
    { tableName: "a", readTableName: "a", schema: [{ name: "k", type: typeA }], rowCount: 5 },
    { tableName: "b", readTableName: "b", schema: [{ name: "k", type: typeB }], rowCount: 3 },
  ];

  it("normalizes both sides of a string key", () => {
    const sql = buildJoinChainSql(1, tables("string", "string"), [m("k", "k")], "a").createSql;
    const norm = (alias: string) =>
      `lower(trim(regexp_replace("${alias}"."k", '\\s+', ' ', 'g')))`;
    expect(sql).toContain(`ON ${norm("a")} = ${norm("b")}`);
  });

  it("leaves a non-string key as a plain comparison", () => {
    const sql = buildJoinChainSql(1, tables("number", "number"), [m("k", "k")], "a").createSql;
    expect(sql).toContain(`ON "a"."k" = "b"."k"`);
    expect(sql).not.toContain("regexp_replace");
    const mixed = buildJoinChainSql(1, tables("string", "number"), [m("k", "k")], "a").createSql;
    expect(mixed).toContain(`ON "a"."k" = "b"."k"`);
  });
});
