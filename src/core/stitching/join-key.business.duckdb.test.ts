/**
 * The business demo keeps its key and anchor: billing_invoices.email ↔
 * crm_customers.Email with billing_invoices as the anchor, 48 rows, no fan-out.
 */
import * as crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBusinessFiles } from "../business-demo";
import { createTestLab, resultSnapshot, type TestLab } from "../recipes/recipe-test-lab";
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
    // The March result is byte-for-byte what it was before text join keys became
    // case-insensitive (hash taken from the previous commit's output).
    const snap = await resultSnapshot(lab.db, stitched.tableName);
    expect(snap.columns.join(",")).toBe(
      "client_name,email,invoice_date,amount,status,region,Customer_Name,Plan,Customer_Since,Monthly_Revenue"
    );
    expect(crypto.createHash("sha256").update(JSON.stringify(snap)).digest("hex")).toBe(
      "fc2211a565894c616b562040e88ca688e8a2b6544e8e9787cfcd9c8488d9ae47"
    );
  }, 120000);
});
