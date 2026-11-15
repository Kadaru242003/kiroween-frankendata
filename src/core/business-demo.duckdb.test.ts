/**
 * Golden test for the business demo: a CRM export and a billing export that
 * never agree. Pins the measured rule scores (engine and thresholds unchanged),
 * the email join, the stitched row count, the CRM Autopsy score, and the two
 * starter answers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAutopsy } from "./autopsy/autopsy-engine";
import { BUSINESS_BILLING_CSV, BUSINESS_CRM_CSV, loadBusinessFiles } from "./business-demo";
import { generateBusinessChips } from "./chat/business-chips";
import { validateSql } from "./chat/sql-validator";
import { createTestLab, resultSnapshot, type TestLab } from "./recipes/recipe-test-lab";
import { AI_CANDIDATE_FLOOR } from "./stitching/ai-budget";
import { createRulesEngine } from "./stitching/rules-engine";
import { createSampleReader } from "./stitching/sample-reader";
import { HIGH_CONFIDENCE_THRESHOLD, MATCH_DISPLAY_THRESHOLD } from "./stitching/types";

let lab: TestLab;
beforeAll(async () => {
  lab = await createTestLab();
  await lab.load(await loadBusinessFiles());
}, 60000);
afterAll(() => lab.dispose());

const num = (v: unknown) => Number(v);

describe("business demo", () => {
  it("loads typed tables (currency and mixed dates inferred)", () => {
    const [crm, billing] = lab.tables();
    expect([crm.tableName, crm.rowCount, billing.tableName, billing.rowCount]).toEqual(["crm_customers", 22, "billing_invoices", 48]);
    expect(crm.schema.map((c) => `${c.name}:${c.type}`)).toEqual([
      "Customer_Name:string", "Email:string", "Region:string", "Plan:string", "Customer_Since:date", "Monthly_Revenue:number",
    ]);
    expect(billing.schema.map((c) => `${c.name}:${c.type}`)).toEqual([
      "client_name:string", "email:string", "invoice_date:date", "amount:number", "status:string", "region:string",
    ]);
  });

  it("scores: a confident email match, a region match, and a borderline name pair the AI could surface", async () => {
    const samples = await createSampleReader(lab.db).readTables(
      lab.tables().map((t) => ({ tableName: t.tableName, schema: t.schema, rowCount: t.rowCount }))
    );
    const scored = createRulesEngine(lab.db).matchAll(samples);
    const byId = new Map(scored.map((m) => [m.id, m.confidence]));
    const email = byId.get("match:billing_invoices.email=crm_customers.Email")!;
    const region = byId.get("match:billing_invoices.region=crm_customers.Region")!;
    const name = byId.get("match:billing_invoices.client_name=crm_customers.Customer_Name")!;
    expect(email).toBeCloseTo(1.0, 2);
    expect(email).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
    expect(region).toBeCloseTo(0.79, 2);
    expect(name).toBeCloseTo(0.383, 2);
    expect(name).toBeGreaterThanOrEqual(AI_CANDIDATE_FLOOR);
    expect(name).toBeLessThan(MATCH_DISPLAY_THRESHOLD);
  });

  it("stitches on the email key with every proposal approved", async () => {
    const { plan } = await lab.approveAllPlan();
    expect(plan.anchorTableName).toBe("billing_invoices");
    expect(plan.joinKeysByPair).toEqual({
      "billing_invoices|crm_customers": "match:billing_invoices.email=crm_customers.Email",
    });
    expect(plan.approvedMatches).toHaveLength(2);
    expect(plan.approvedCleanings).toHaveLength(12);
    const stitched = await lab.controller.applyPlan(plan);
    expect(stitched.rowCount).toBe(48);
    expect(lab.stitchStore.getState().fanOut).toMatchObject({ anchorRowCount: 48, resultRowCount: 48, fannedOut: false });
    const snap = await resultSnapshot(lab.db, stitched.tableName);
    expect(snap.columns).toEqual([
      "client_name", "email", "invoice_date", "amount", "status", "region",
      "Customer_Name", "Region_1", "Plan", "Customer_Since", "Monthly_Revenue",
    ]);
    // Billing emails that differ in casing still join after the case cleanup.
    expect(snap.rows.filter((r) => JSON.parse(r)[6] === null)).toHaveLength(0);
  });

  it("the CRM Autopsy score is 79 with 2 duplicate rows", async () => {
    const crm = lab.tables().find((t) => t.tableName === "crm_customers")!;
    const rep = await runAutopsy(lab.db, { tableName: crm.tableName, schema: crm.schema, rowCount: crm.rowCount }, { allowFixes: false });
    expect(rep.health.score).toBe(79);
    expect(rep.duplicateRows).toBe(2);
    expect(rep.health.breakdown.map((b) => [b.code, b.points])).toEqual([["duplicates", 9], ["nulls", 1], ["whitespace", 2], ["variants", 9]]);
  });

  it("starter chips pass the validator and give the pinned answers", async () => {
    const chips = generateBusinessChips(lab.tables().map((t) => ({ tableName: t.tableName, columns: t.schema })));
    expect(chips.map((c) => c.chart?.type)).toEqual(["bar", "line"]);
    const names = [...lab.tables().map((t) => t.tableName), "stitch_1_result"];
    const run = async (i: number) => {
      const v = validateSql(chips[i].sql, names);
      expect(v.ok).toBe(true);
      return v.ok ? lab.db.query<Record<string, unknown>>(v.sql) : [];
    };
    const region = (await run(0)).map((r) => [r.Region, num(r.monthly_revenue)]);
    expect(region).toEqual([["North America", 34220], ["EMEA", 17850], ["APAC", 9430], ["emea", 1750]]);
    const monthly = (await run(1)).map((r) => num(r.total_amount));
    expect(monthly).toEqual([25982.5, 34368.6, 27623.5, 36472.8, 29264.5, 38577]);
  });

  it("the bundled CSV strings are the files that load", async () => {
    const files = await loadBusinessFiles();
    expect(await files[0].text()).toBe(BUSINESS_CRM_CSV);
    expect(await files[1].text()).toBe(BUSINESS_BILLING_CSV);
  });
});
