/**
 * The business demo keeps its key and anchor: billing_invoices.email ↔
 * crm_customers.Email with billing_invoices as the anchor, 48 rows, no fan-out.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBusinessFiles } from "../business-demo";
import { createTestLab, type TestLab } from "../recipes/recipe-test-lab";
import { pairKey } from "./plan-assembly";

let lab: TestLab;
beforeAll(async () => {
  lab = await createTestLab();
  await lab.load(await loadBusinessFiles());
}, 120000);
afterAll(() => lab.dispose());

describe("business demo default key and anchor", () => {
  it("keeps the email key, the billing anchor and 48 rows without fan-out", async () => {
    const { plan } = await lab.approveAllPlan();
    expect(plan.joinKeysByPair[pairKey("billing_invoices", "crm_customers")]).toBe(
      "match:billing_invoices.email=crm_customers.Email"
    );
    expect(plan.anchorTableName).toBe("billing_invoices");
    const stitched = await lab.controller.applyPlan(plan);
    expect(stitched.rowCount).toBe(48);
    expect(lab.stitchStore.getState().fanOut).toEqual({
      anchorRowCount: 48,
      resultRowCount: 48,
      fannedOut: false,
    });
  }, 120000);
});
