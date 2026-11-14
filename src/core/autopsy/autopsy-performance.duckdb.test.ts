/**
 * Performance test for the Autopsy (Feature 4, task 12; Requirement 7.4).
 *
 * Builds a 100,000 row by 20 column table directly in DuckDB (7 string, 7
 * number, 3 date, 3 boolean columns) and measures a full autopsy against
 * AUTOPSY_TARGET_MS. This runs on the node-blocking WASM bundle, the same
 * engine as the browser. It also checks progressive reporting on a large table.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { runAutopsy } from "./autopsy-engine";
import { AUTOPSY_TARGET_MS, type AutopsyReport, type AutopsyTarget } from "./types";
import type { ColumnSchema } from "../types";

const ROWS = 100_000;

let duck: TestDuckDB;
let target: AutopsyTarget;

beforeAll(async () => {
  duck = await createTestDuckDB();
  const schema: ColumnSchema[] = [];
  const exprs: string[] = [];
  for (let k = 0; k < 7; k += 1) {
    schema.push({ name: `s${k}`, type: "string" });
    exprs.push(`'name_' || CAST(i % ${50 + k * 700} AS VARCHAR) AS s${k}`);
  }
  for (let k = 0; k < 7; k += 1) {
    schema.push({ name: `n${k}`, type: "number" });
    exprs.push(`CAST((i * ${k + 3}) % ${97 + k * 13} AS DOUBLE) AS n${k}`);
  }
  for (let k = 0; k < 3; k += 1) {
    schema.push({ name: `d${k}`, type: "date" });
    exprs.push(`DATE '2020-01-01' + CAST(i % ${400 + k * 100} AS INTEGER) AS d${k}`);
  }
  for (let k = 0; k < 3; k += 1) {
    schema.push({ name: `b${k}`, type: "boolean" });
    exprs.push(`(i % ${k + 2} = 0) AS b${k}`);
  }
  await duck.service.query(
    `CREATE TABLE perf AS SELECT ${exprs.join(", ")} FROM range(${ROWS}) t(i)`
  );
  target = { tableName: "perf", schema, rowCount: ROWS };
}, 120_000);

afterAll(() => duck?.dispose());

describe("Autopsy performance: 100,000 rows by 20 columns", () => {
  it("completes within the target time and reports progressively", async () => {
    expect(target.schema.length).toBe(20);
    const snapshots: AutopsyReport[] = [];
    const start = performance.now();
    const report = await runAutopsy(duck.service, target, {
      onProgress: (s) => snapshots.push(s),
    });
    const elapsed = performance.now() - start;

    expect(report.status).toBe("ok");
    expect(report.complete).toBe(true);
    expect(report.rows).toBe(ROWS);
    expect(report.columnCount).toBe(20);
    // Progress: after stage A, then once per column.
    expect(snapshots.length).toBeGreaterThanOrEqual(21);
    expect(snapshots.every((s) => !s.complete)).toBe(true);
    // The performance target (Requirement 7.4).
    expect(elapsed, `autopsy took ${Math.round(elapsed)} ms`).toBeLessThan(AUTOPSY_TARGET_MS);
  }, 60_000);
});
