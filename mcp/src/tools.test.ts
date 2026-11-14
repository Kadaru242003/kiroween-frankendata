// @vitest-environment node
/** Unit tests per tool handler: success and every documented error code. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecipe, serializeRecipe } from "../../src/core/recipes/recipe-builder";
import { startHarness, type TestHarness } from "./test-support";

let h: TestHarness;
beforeEach(async () => {
  h = await startHarness();
}, 60000);
afterEach(() => h.close());

const loadBoth = () => h.call("frankendata_load_files", { paths: ["monsters.csv", "experiments.csv"] });
const proposeAll = async () => {
  const p = await h.call("frankendata_propose_stitch");
  return [...p.data.matches.map((m: any) => m.id), ...p.data.cleanings.map((c: any) => c.id)] as string[];
};

describe("load_files", () => {
  it("reports a missing file and a bad extension without stopping the others", async () => {
    fs.writeFileSync(path.join(h.root, "notes.txt"), "hello");
    const r = await h.call("frankendata_load_files", {
      paths: ["monsters.csv", "notes.txt", "missing.csv"],
    });
    expect(r.isError).toBe(false);
    expect(r.data.tables.map((t: any) => t.tableName)).toEqual(["monsters"]);
    const codes = r.data.failures.map((f: any) => f.code).sort();
    expect(codes).toEqual(["file-not-found", "unsupported-type"]);
  }, 60000);
  it("returns an error when nothing is readable", async () => {
    const r = await h.call("frankendata_load_files", { paths: ["../nope.csv"] });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("path-outside-root");
  });
  it("suffixes a name collision and does not drop tables", async () => {
    await h.call("frankendata_load_files", { paths: ["monsters.csv"] });
    const r = await h.call("frankendata_load_files", { paths: ["monsters.csv"] });
    expect(r.data.tables.map((t: any) => t.tableName)).toEqual(["monsters_2"]);
  }, 60000);
  it("rejects invalid input", async () => {
    const r = await h.call("frankendata_load_files", { paths: [] });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("invalid-input");
  });
});

describe("autopsy", () => {
  it("returns JSON plus Markdown, without Fix it actions", async () => {
    await loadBoth();
    const res = (await h.client.callTool({ name: "frankendata_autopsy", arguments: { table: "monsters" } })) as any;
    expect(res.content).toHaveLength(2);
    expect(res.content[1].text).toContain("# Autopsy case file: monsters");
    expect(res.structuredContent.report.fixes).toEqual([]);
  }, 60000);
  it("lists available tables when the table is unknown", async () => {
    await loadBoth();
    const r = await h.call("frankendata_autopsy", { table: "ghost" });
    expect(r.data.error.code).toBe("table-not-found");
    expect(r.data.error.message).toContain("monsters");
  }, 60000);
});

describe("propose_stitch", () => {
  it("needs tables, rejects unknown names, and is deterministic", async () => {
    expect((await h.call("frankendata_propose_stitch")).data.error.code).toBe("table-not-found");
    await loadBoth();
    expect((await h.call("frankendata_propose_stitch", { tables: ["ghost"] })).data.error.code).toBe("table-not-found");
    const a = await h.call("frankendata_propose_stitch");
    const b = await h.call("frankendata_propose_stitch");
    expect(a.data).toEqual(b.data);
    expect(a.data.aiUsed).toBe(false);
  }, 60000);
});

describe("apply_stitch", () => {
  it("rejects with no proposals, stale proposals, unknown ids, bad anchor and bad keys", async () => {
    await loadBoth();
    expect((await h.call("frankendata_apply_stitch", { approvedIds: [] })).data.error.code).toBe("no-proposals");
    const ids = await proposeAll();
    expect((await h.call("frankendata_apply_stitch", { approvedIds: ["clean:nope"] })).data.error.code).toBe("unknown-proposal");
    expect((await h.call("frankendata_apply_stitch", { approvedIds: ids, anchor: "ghost" })).data.error.code).toBe("table-not-found");
    expect(
      (await h.call("frankendata_apply_stitch", { approvedIds: [], joinKeys: { "a|b": ids[0] } })).data.error.code
    ).toBe("unknown-proposal");
    fs.copyFileSync(path.join(h.root, "monsters.csv"), path.join(h.root, "extra.csv"));
    await h.call("frankendata_load_files", { paths: ["extra.csv"] });
    expect((await h.call("frankendata_apply_stitch", { approvedIds: ids })).data.error.code).toBe("proposals-stale");
  }, 60000);

  it("applies only the ids that were passed in", async () => {
    await loadBoth();
    await proposeAll();
    const r = await h.call("frankendata_apply_stitch", { approvedIds: ["clean:duplicate-rows:monsters"] });
    expect(r.isError).toBe(false);
    expect(r.data.rowCount).toBe(12);
    expect(r.data.createdTables).toEqual(["stitch_1_clean_monsters", "stitch_1_result"]);
    const names = r.data.schema.map((c: any) => c.name);
    expect(names).not.toContain("danger_level");
  }, 60000);

  it("a second apply uses the next counter and keeps the first result", async () => {
    await loadBoth();
    const ids = await proposeAll();
    await h.call("frankendata_apply_stitch", { approvedIds: ids });
    const second = await h.call("frankendata_apply_stitch", { approvedIds: ids });
    expect(second.data.resultTable).toBe("stitch_2_result");
    const q = await h.call("frankendata_query", { sql: "SELECT COUNT(*) AS n FROM stitch_1_result" });
    expect(q.data.rows[0].n).toBe(12);
  }, 60000);
});

describe("query", () => {
  it("rejects unsafe statements and reports runtime errors", async () => {
    await loadBoth();
    for (const sql of [
      "DROP TABLE monsters",
      "SELECT 1; SELECT 2",
      "SELECT * FROM nope",
      "SELECT * FROM read_csv('x.csv')",
      "",
    ]) {
      const r = await h.call("frankendata_query", { sql });
      expect(r.data.error.code).toBe("sql-rejected");
    }
    const bad = await h.call("frankendata_query", { sql: "SELECT CAST(Species AS INTEGER) FROM monsters" });
    expect(bad.data.error.code).toBe("query-failed");
  }, 60000);
  it("returns plain values and truncates large results", async () => {
    await loadBoth();
    const r = await h.call("frankendata_query", { sql: "SELECT Monster_Name, Sedated FROM monsters ORDER BY Monster_Name LIMIT 2" });
    expect(r.data.rows).toEqual([
      { Monster_Name: "Bellow", Sedated: false },
      { Monster_Name: "Blinky", Sedated: true },
    ]);
    const big = await h.call("frankendata_query", { sql: "SELECT * FROM monsters a, monsters b, monsters c" });
    expect(big.data.truncated).toBe(true);
    expect(big.data.rows).toHaveLength(200);
    expect(big.data.rowCount).toBe(1000); // the validator adds LIMIT 1000
  }, 60000);
});

describe("export", () => {
  it("writes XLSX, checks names and the output folder", async () => {
    await loadBoth();
    const ok = await h.call("frankendata_export", { table: "monsters", format: "xlsx" });
    expect(ok.data.path).toBe(path.join("frankendata-output", "monsters.xlsx"));
    expect(fs.statSync(path.join(h.root, ok.data.path)).size).toBe(ok.data.bytes);
    expect((await h.call("frankendata_export", { table: "monsters", format: "csv", fileName: "x.txt" })).data.error.code).toBe("invalid-input");
    expect((await h.call("frankendata_export", { table: "monsters", format: "csv", fileName: "../x.csv" })).data.error.code).toBe("path-outside-root");
    expect((await h.call("frankendata_export", { table: "ghost", format: "csv" })).data.error.code).toBe("table-not-found");
  }, 60000);
  it("refuses to write through a symbolic link", async () => {
    await loadBoth();
    const dir = path.join(h.root, "frankendata-output");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(h.root, "precious.csv");
    fs.writeFileSync(target, "keep");
    fs.symlinkSync(target, path.join(dir, "monsters.csv"));
    const r = await h.call("frankendata_export", { table: "monsters", format: "csv", overwrite: true });
    expect(r.data.error.code).toBe("path-outside-root");
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  }, 60000);
});

describe("reset", () => {
  it("drops everything and allows a fresh load", async () => {
    await loadBoth();
    await h.call("frankendata_reset");
    const r = await h.call("frankendata_load_files", { paths: ["monsters.csv"] });
    expect(r.data.tables[0].tableName).toBe("monsters");
  }, 60000);
});

describe("apply_recipe", () => {
  it("replays a saved recipe on freshly loaded tables", async () => {
    await loadBoth();
    const ids = await proposeAll();
    const first = await h.call("frankendata_apply_stitch", { approvedIds: ids });
    const state = h.app.session.stitchStore.getState();
    const recipe = buildRecipe({
      plan: state.plan!,
      tables: h.app.session.tables(),
      decisions: state.decisions,
      now: new Date(0),
    });
    fs.writeFileSync(path.join(h.root, "recipe.json"), serializeRecipe(recipe));
    await h.call("frankendata_reset");
    await loadBoth();
    const r = await h.call("frankendata_apply_recipe", { path: "recipe.json" });
    expect(r.isError).toBe(false);
    expect(r.data.rowCount).toBe(first.data.rowCount);
    expect(r.data.notApplied).toEqual([]);
    expect(r.data.preApproved).toBeGreaterThan(0);
  }, 60000);
  it("rejects invalid recipes, outside paths and oversized files, changing nothing", async () => {
    await loadBoth();
    fs.writeFileSync(path.join(h.root, "bad.json"), '{"format":"nope"}');
    const bad = await h.call("frankendata_apply_recipe", { path: "bad.json" });
    expect(bad.data.error.code).toBe("invalid-recipe");
    expect(h.app.session.stitchStore.getState().proposals).toBeNull();
    expect((await h.call("frankendata_apply_recipe", { path: "../r.json" })).data.error.code).toBe("path-outside-root");
    fs.writeFileSync(path.join(h.root, "big.json"), "x".repeat(300000));
    expect((await h.call("frankendata_apply_recipe", { path: "big.json" })).data.error.code).toBe("invalid-recipe");
  }, 60000);
});
