/**
 * Business month two: stitch the March business files, save a recipe, reset
 * the lab, load next month's business files (crm_customers.csv plus
 * billing_invoices_2026_04.csv), apply the recipe. Every recipe step must be
 * pre-approved with nothing left in the "not applied" list, and the stitched
 * result must have one row per April invoice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBusinessFiles } from "../business-demo";
import { assembleStitchPlan } from "../stitching/plan-assembly";
import type { ApprovalDecision } from "../stitching/types";
import { loadBusinessNextMonthFiles } from "./business-next-month-demo";
import { applyRecipeText } from "./recipe-apply";
import { buildRecipe, serializeRecipe } from "./recipe-builder";
import { applyRecipeOverrides } from "./recipe-mapper";
import { createTestLab, type TestLab } from "./recipe-test-lab";

const NOW = new Date("2026-04-30T10:00:00.000Z");

let lab: TestLab;
let recipeText = "";
let recipeSteps = 0;

beforeAll(async () => {
  lab = await createTestLab();
  await lab.load(await loadBusinessFiles());
  const { plan, decisions } = await lab.approveAllPlan();
  await lab.controller.applyPlan(plan);
  const recipe = buildRecipe({ plan, tables: lab.tables(), decisions, now: NOW });
  recipeSteps = recipe.matches.length + recipe.cleanings.length;
  recipeText = serializeRecipe(recipe);
}, 120000);
afterAll(() => lab.dispose());

describe("business month two", () => {
  it("loads crm_customers plus billing_invoices_2026_04 with 2 new customers and 2 duplicate CRM rows", async () => {
    await lab.reset();
    const tables = await lab.load(await loadBusinessNextMonthFiles());
    const byName = Object.fromEntries(tables.map((t) => [t.tableName, t]));
    expect(Object.keys(byName).sort()).toEqual(["billing_invoices_2026_04", "crm_customers"]);
    expect(byName.crm_customers.rowCount).toBe(24); // 22 customers + 2 exact duplicates
    expect(byName.billing_invoices_2026_04.rowCount).toBe(24);
    // Same headers and types as March, so the recipe maps the renamed billing table by schema.
    expect(byName.crm_customers.schema.map((c) => `${c.name}:${c.type}`)).toEqual([
      "Customer_Name:string", "Email:string", "Region:string", "Plan:string",
      "Customer_Since:date", "Monthly_Revenue:number",
    ]);
    expect(byName.billing_invoices_2026_04.schema.map((c) => `${c.name}:${c.type}`)).toEqual([
      "client_name:string", "email:string", "invoice_date:date", "amount:number", "status:string", "region:string",
    ]);
  }, 120000);

  it("applying the March recipe pre-approves every step with 0 not applied", async () => {
    const res = await applyRecipeText(recipeText, {
      tables: lab.tables(),
      store: lab.stitchStore,
      computeProposals: () => lab.controller.computeProposals(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mapping.notApplied).toEqual([]);
    expect(res.mapping.mappedCount).toBe(recipeSteps);
    expect(Object.keys(lab.stitchStore.getState().decisions)).toHaveLength(recipeSteps);
    expect(res.mapping.overrides.anchor).toBe("billing_invoices_2026_04");
    expect(res.mapping.tableMap).toEqual({
      crm_customers: "crm_customers",
      billing_invoices: "billing_invoices_2026_04",
    });

    const state = lab.stitchStore.getState();
    const plan = applyRecipeOverrides(
      assembleStitchPlan(state.proposals!, state.decisions as Record<string, ApprovalDecision>, lab.tables()),
      res.mapping.overrides,
      lab.tables().map((t) => t.tableName)
    );
    expect(plan.anchorTableName).toBe("billing_invoices_2026_04");
    const stitched = await lab.controller.applyPlan(plan);
    // One row per April invoice: the CRM duplicates are removed, so no fan-out.
    expect(stitched.rowCount).toBe(24);
    expect(lab.stitchStore.getState().fanOut).toEqual({
      anchorRowCount: 24,
      resultRowCount: 24,
      fannedOut: false,
    });

    // Every invoice whose email exists in crm_customers (case-insensitively) has
    // its CRM columns; report how many April rows are unmatched.
    const crm = await lab.db.query<{ email: string }>(
      `SELECT DISTINCT lower(trim("Email")) AS email FROM crm_customers`
    );
    const crmEmails = new Set(crm.map((r) => r.email));
    const result = await lab.db.query<Record<string, unknown>>(
      `SELECT email, "Plan", "Customer_Name" FROM ${stitched.tableName}`
    );
    expect(result).toHaveLength(24);
    const inCrm = result.filter((r) => crmEmails.has(String(r.email).trim().toLowerCase()));
    const unmatched = result.filter((r) => !crmEmails.has(String(r.email).trim().toLowerCase()));
    expect(inCrm.filter((r) => r.Plan === null || r.Plan === undefined)).toEqual([]);
    expect(inCrm.filter((r) => r.Customer_Name === null || r.Customer_Name === undefined)).toEqual([]);
    // Every April invoice belongs to a CRM customer (the 2 new ones are in the CRM file).
    expect(unmatched).toHaveLength(0);
    expect(inCrm).toHaveLength(24);
  }, 120000);
});
