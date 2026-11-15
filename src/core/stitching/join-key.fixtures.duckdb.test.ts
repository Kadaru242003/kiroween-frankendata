/**
 * The vendors.csv + purchases.xlsx fixtures (mcp/fixtures): country matches
 * better than email (79% against 55%) but is low-cardinality, so joining on it
 * fans 6 rows out to 12. The default key must be purchases.email ↔
 * vendors.Contact_Email, the anchor must be purchases (the side where the key
 * repeats), and the stitched result must have 5 rows with no fan-out.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestLab, type TestLab } from "../recipes/recipe-test-lab";
import { statsKey } from "./key-stats";
import { pairKey } from "./plan-assembly";

const FIXTURES = path.resolve(__dirname, "../../../mcp/fixtures");

function fixtureFiles(): File[] {
  return [
    new File([fs.readFileSync(path.join(FIXTURES, "vendors.csv"))], "vendors.csv", { type: "text/csv" }),
    new File([fs.readFileSync(path.join(FIXTURES, "purchases.xlsx"))], "purchases.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  ];
}

const EMAIL = "match:purchases.email=vendors.Contact_Email";
const COUNTRY = "match:purchases.country=vendors.Country";

let lab: TestLab;
beforeAll(async () => {
  lab = await createTestLab();
  await lab.load(fixtureFiles());
}, 120000);
afterAll(() => lab.dispose());

describe("vendors + purchases: default key, anchor and result", () => {
  it("proposes both matches, country with the higher confidence", async () => {
    const proposals = await lab.controller.computeProposals();
    const byId = new Map(proposals.matches.map((m) => [m.id, m]));
    expect(byId.get(COUNTRY)).toBeDefined();
    expect(byId.get(EMAIL)).toBeDefined();
    expect(byId.get(COUNTRY)!.confidence).toBeGreaterThan(byId.get(EMAIL)!.confidence);
  });

  it("measures the key-likeness of the columns on normalized values", async () => {
    const proposals = await lab.controller.computeProposals();
    const stats = proposals.columnStats!;
    // Vendors has a case-only duplicate row (Acme / ACME), so after the proposed
    // cleanup its email is unique; purchases repeats the Acme address.
    expect(stats[statsKey("vendors", "Contact_Email")].distinctRatio).toBe(1);
    expect(stats[statsKey("purchases", "email")].distinctRatio).toBeCloseTo(0.8, 5);
    expect(stats[statsKey("purchases", "country")].distinctRatio).toBeCloseTo(0.6, 5);
  });

  it("finds the case-only duplicate vendor row", async () => {
    const proposals = await lab.controller.computeProposals();
    const dup = proposals.cleanings.find((c) => c.id === "clean:duplicate-rows:vendors");
    expect(dup).toBeDefined();
    expect(dup!.before).toEqual({ rowCount: 6 });
    expect(dup!.after).toEqual({ rowCount: 5 });
  });

  it("defaults to email, anchors on purchases, and stitches 5 rows with no fan-out", async () => {
    const { plan } = await lab.approveAllPlan();
    expect(plan.joinKeysByPair[pairKey("purchases", "vendors")]).toBe(EMAIL);
    expect(plan.anchorTableName).toBe("purchases");

    const stitched = await lab.controller.applyPlan(plan);
    expect(stitched.rowCount).toBe(5);
    const fan = lab.stitchStore.getState().fanOut;
    expect(fan).toEqual({ anchorRowCount: 5, resultRowCount: 5, fannedOut: false });
  }, 120000);

  it("matches Eastgate Foods (INFO@eastgate.example) case-insensitively, with no NULL vendor columns", async () => {
    const rows = await lab.db.query<Record<string, unknown>>(
      `SELECT * FROM stitch_1_result`
    );
    expect(rows).toHaveLength(5);
    const eastgate = rows.filter((r) => String(r.email).toLowerCase() === "info@eastgate.example");
    expect(eastgate).toHaveLength(1);
    expect(Number(eastgate[0].Annual_Spend)).toBe(5400);
    // All five purchases match a vendor that has a spend and a status, so no
    // cell of the result is NULL.
    for (const r of rows) {
      expect(Object.keys(r)).toEqual(expect.arrayContaining(["Annual_Spend", "Status"]));
      for (const [col, value] of Object.entries(r)) {
        expect(value, `${String(r.email)} ${col}`).not.toBeNull();
        expect(value, `${String(r.email)} ${col}`).not.toBeUndefined();
      }
    }
    // The anchor side keeps its display value (purchases wrote INFO@...).
    expect(eastgate[0].email).toBe("INFO@eastgate.example");
  });

  it("still honors a key the user picks in the dropdown (country fans out)", async () => {
    await lab.controller.undo();
    const { plan } = await lab.approveAllPlan();
    const chosen = { ...plan, joinKeysByPair: { [pairKey("purchases", "vendors")]: COUNTRY } };
    const stitched = await lab.controller.applyPlan(chosen);
    expect(stitched.rowCount).toBeGreaterThan(5);
    expect(lab.stitchStore.getState().fanOut?.fannedOut).toBe(true);
  }, 120000);
});
