/**
 * DuckDB-backed unit tests for the Autopsy engine and Fix it mapping
 * (Feature 4, tasks 4 and 5). Real SQL over small hand-made tables.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { runAutopsy } from "./autopsy-engine";
import { buildFixActions } from "./fix-it";
import type { AutopsyReport, AutopsyTarget } from "./types";
import type { CellValue, ColumnSchema, DuckDBService } from "../types";

let duck: TestDuckDB;

beforeAll(async () => {
  duck = await createTestDuckDB();
  const svc = duck.service;
  await make(svc, "t1", [
    { name: "name", type: "string" },
    { name: "power", type: "number" },
    { name: "seen", type: "date" },
    { name: "ok", type: "boolean" },
  ], [
    ["Ann", "10", "2026-01-01", "true"],
    ["Bob", "20", "2026-01-03", "false"],
    ["Cy", "30", "2026-01-05", "true"],
    ["Dee", "40", null, "true"],
    ["Eve", "1000", "2026-01-07", null],
  ]);
  await make(svc, "t2", [{ name: "s", type: "string" }], [
    ["Alpha"], ["alpha"], ["ALPHA "], ["Beta"], ["Beta"], ["a  b"],
  ]);
  await make(svc, "t3", [{ name: "a", type: "string" }, { name: "b", type: "number" }], []);
  await make(svc, "t4", [
    { name: "a", type: "string" },
    { name: "b", type: "number" },
    { name: "c", type: "string" },
  ], [
    ["x", null, "p"],
    ["x", null, "q"],
    ["x", null, null],
  ]);
  await make(svc, "t5", [{ name: "a", type: "string" }, { name: "b", type: "string" }], [
    [null, "1"], [null, "1"], ["a", "2"],
  ]);
});

afterAll(() => duck?.dispose());

async function make(
  svc: DuckDBService,
  name: string,
  schema: ColumnSchema[],
  rows: CellValue[][]
): Promise<void> {
  await svc.createTable(name, schema, rows);
}

async function target(name: string): Promise<AutopsyTarget> {
  const rows = await duck.service.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${name}' ORDER BY ordinal_position`
  );
  const type = (t: string): ColumnSchema["type"] =>
    t === "DOUBLE" ? "number" : t === "DATE" ? "date" : t === "BOOLEAN" ? "boolean" : "string";
  const count = await duck.service.getRowCount(name);
  return {
    tableName: name,
    schema: rows.map((r) => ({ name: String(r.column_name), type: type(String(r.data_type)) })),
    rowCount: count,
  };
}

const col = (r: AutopsyReport, name: string) => r.columns.find((c) => c.name === name)!;

describe("runAutopsy on a mixed table", () => {
  let r: AutopsyReport;
  beforeAll(async () => {
    r = await runAutopsy(duck.service, await target("t1"));
  });

  it("reports table basics", () => {
    expect(r.status).toBe("ok");
    expect(r.complete).toBe(true);
    expect(r.rows).toBe(5);
    expect(r.columnCount).toBe(4);
    expect(r.duplicateRows).toBe(0);
    // Both columns are non-null and unique across the 5 rows.
    expect(r.candidateKeys).toEqual(["name", "power"]);
  });

  it("reports nulls, distinct counts, and top values in a stable order", () => {
    const seen = col(r, "seen");
    expect(seen.nullCount).toBe(1);
    expect(seen.nullPct).toBeCloseTo(20, 10);
    const name = col(r, "name");
    expect(name.distinct).toBe(5);
    expect(name.topValues?.map((t) => t.value)).toEqual(["Ann", "Bob", "Cy", "Dee", "Eve"]);
    expect(col(r, "ok").topValues).toEqual([
      { value: "true", count: 3 },
      { value: "false", count: 1 },
    ]);
  });

  it("reports numeric statistics and the outlier with examples", () => {
    const p = col(r, "power");
    expect(p.min).toBe(10);
    expect(p.max).toBe(1000);
    expect(p.median).toBe(30);
    expect(p.mean).toBe(220);
    expect(p.outliers?.count).toBe(1);
    expect(p.outliers?.examples).toEqual([1000]);
    expect(p.status).toBe("critical");
  });

  it("reports date statistics as YYYY-MM-DD", () => {
    const s = col(r, "seen");
    expect(s.min).toBe("2026-01-01");
    expect(s.max).toBe("2026-01-07");
    expect(s.median).toBe("2026-01-04");
    expect(s.mean).toBe("2026-01-04");
  });

  it("scores the table with a transparent breakdown", () => {
    // nulls: mean (0+0+20+20)/4 = 10 -> 5 points; outliers: 1 column -> 2 points.
    expect(r.health.score).toBe(93);
    expect(r.health.breakdown.map((d) => d.code)).toEqual(["nulls", "outliers"]);
  });

  it("offers no fixes for a clean table", () => {
    expect(r.fixes).toEqual([]);
  });
});

describe("runAutopsy string variants and duplicates", () => {
  it("counts whitespace rows and case-variant groups", async () => {
    const r = await runAutopsy(duck.service, await target("t2"));
    const s = col(r, "s");
    expect(s.whitespaceRows).toBe(2); // "ALPHA " and "a  b"
    expect(s.caseVariantGroups).toBe(1); // alpha, Alpha, ALPHA
    expect(r.duplicateRows).toBe(1); // Beta twice
    expect(s.status).toBe("warning");
  });

  it("treats NULLs as equal when counting duplicate rows", async () => {
    const r = await runAutopsy(duck.service, await target("t5"));
    expect(r.duplicateRows).toBe(1);
  });
});

describe("runAutopsy structural findings", () => {
  it("handles a table with zero rows", async () => {
    const r = await runAutopsy(duck.service, await target("t3"));
    expect(r.status).toBe("ok");
    expect(r.rows).toBe(0);
    expect(r.candidateKeys).toEqual([]);
    expect(r.allNullColumns).toEqual([]);
    expect(r.constantColumns).toEqual([]);
    expect(r.health.score).toBe(100);
    expect(col(r, "a").nullPct).toBe(0);
  });

  it("finds all-null and constant columns", async () => {
    const r = await runAutopsy(duck.service, await target("t4"));
    expect(r.allNullColumns).toEqual(["b"]);
    expect(r.constantColumns).toEqual(["a"]);
    expect(col(r, "b").status).toBe("critical");
    expect(col(r, "a").status).toBe("warning");
  });
});

describe("runAutopsy safety and progress", () => {
  it("issues only read-only SELECT statements", async () => {
    const seen: string[] = [];
    const spy: DuckDBService = {
      ...duck.service,
      query: (async (sql: string) => {
        seen.push(sql);
        return duck.service.query(sql);
      }) as DuckDBService["query"],
    };
    await runAutopsy(spy, await target("t2"));
    expect(seen.length).toBeGreaterThan(3);
    for (const sql of seen) {
      expect(sql.trimStart()).toMatch(/^SELECT\b/i);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|COPY|PRAGMA)\b/i);
    }
  });

  it("reports progress incrementally, ending with a complete report", async () => {
    const snaps: AutopsyReport[] = [];
    const final = await runAutopsy(duck.service, await target("t1"), {
      onProgress: (s) => snaps.push(s),
    });
    // After stage A, then once per column.
    expect(snaps.length).toBeGreaterThanOrEqual(1 + 4);
    expect(snaps.every((s) => s.complete === false)).toBe(true);
    expect(snaps[0].columns.length).toBe(4);
    expect(final.complete).toBe(true);
  });
});

describe("buildFixActions (existing cleaning rules)", () => {
  it("maps whitespace and duplicate findings to existing proposal ids", async () => {
    const actions = await buildFixActions(duck.service, await target("t2"));
    const ids = actions.map((a) => a.proposalId);
    expect(ids).toContain("clean:whitespace:t2.s");
    expect(ids).toContain("clean:duplicate-rows:t2");
    const dup = actions.find((a) => a.kind === "duplicate-rows")!;
    expect(dup.columnName).toBeUndefined();
    expect(dup.proposal.kind).toBe("duplicate-rows");
  });

  it("offers nothing for a clean table", async () => {
    expect(await buildFixActions(duck.service, await target("t1"))).toEqual([]);
  });

  it("offers no fixes when allowFixes is false", async () => {
    const r = await runAutopsy(duck.service, await target("t2"), { allowFixes: false });
    expect(r.fixes).toEqual([]);
  });

  it("includes the fix actions in the report by default", async () => {
    const r = await runAutopsy(duck.service, await target("t2"));
    expect(r.fixes.map((f) => f.proposalId)).toContain("clean:whitespace:t2.s");
  });
});
