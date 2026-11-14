// @vitest-environment node
/**
 * Feature: frankendata-mcp, Property 4: for the bundled demo files the MCP
 * results equal the web app core results for the same inputs.
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAutopsy } from "../../src/core/autopsy/autopsy-engine";
import { demoDataLoader } from "../../src/core/demo-data-loader";
import { createTestLab, resultSnapshot, type TestLab } from "../../src/core/recipes/recipe-test-lab";
import { startHarness, type TestHarness } from "./test-support";

let h: TestHarness;
let lab: TestLab;
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

beforeAll(async () => {
  h = await startHarness();
  lab = await createTestLab();
  await lab.load(await demoDataLoader.loadMismatched());
}, 60000);
afterAll(async () => {
  await h.close();
  lab.dispose();
});

describe("Feature: frankendata-mcp, Property 4: parity with the web app core", () => {
  it("loaded tables, autopsy, proposals and the stitched result are identical", async () => {
    // Load
    const loaded = await h.call("frankendata_load_files", {
      paths: [path.join("monsters.csv"), path.join("experiments.csv")],
    });
    expect(loaded.data.tables).toEqual(
      lab.tables().map((t) => ({
        tableName: t.tableName,
        sourceFileName: t.sourceFileName,
        rowCount: t.rowCount,
        columns: t.schema.map((c) => ({ name: c.name, type: c.type })),
      }))
    );
    // Autopsy
    for (const t of lab.tables()) {
      const direct = await runAutopsy(
        lab.db,
        { tableName: t.tableName, schema: t.schema, rowCount: t.rowCount },
        { allowFixes: false }
      );
      const viaMcp = await h.call("frankendata_autopsy", { table: t.tableName });
      expect(viaMcp.data.report).toEqual(json(direct));
    }
    // Proposals
    const direct = await lab.controller.computeProposals();
    const viaMcp = await h.call("frankendata_propose_stitch");
    expect(viaMcp.data.matches.map((m: any) => [m.id, m.confidence, m.reason])).toEqual(
      direct.matches.map((m) => [m.id, m.confidence, m.reason])
    );
    expect(viaMcp.data.cleanings.map((c: any) => [c.id, c.kind, c.reason])).toEqual(
      direct.cleanings.map((c) => [c.id, c.kind, c.reason])
    );
    // Stitched result with every proposal approved
    const ids = [...direct.matches.map((m) => m.id), ...direct.cleanings.map((c) => c.id)];
    const applied = await h.call("frankendata_apply_stitch", { approvedIds: ids });
    const { plan } = await lab.approveAllPlan();
    const stitched = await lab.controller.applyPlan(plan);
    const snap = await resultSnapshot(lab.db, stitched.tableName);
    expect(applied.data.schema.map((c: any) => c.name)).toEqual(snap.columns);
    expect(applied.data.rowCount).toBe(stitched.rowCount);
    const mcpRows = applied.data.rows
      .map((r: any) => JSON.stringify(snap.columns.map((c) => (r[c] === null ? null : String(r[c])))))
      .sort();
    expect(mcpRows).toEqual(snap.rows);
  }, 120000);
});
