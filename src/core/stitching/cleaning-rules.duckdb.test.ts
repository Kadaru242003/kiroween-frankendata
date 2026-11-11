/**
 * DuckDB-backed tests for the cleaning rules whose before/after counts come
 * from SQL over the FULL column (Feature 2, task 7): duplicate-rows and
 * number-column outliers.
 *
 * These assert that:
 *   - duplicate-rows is proposed from a full-table count (not the bounded
 *     samples) and reports the correct before/after row counts, with
 *     normalized (trim/collapse + case-insensitive-on-whitespace) grouping;
 *   - outliers is proposed only for number columns, using the same
 *     `quantile_cont` Tukey fences the apply step uses, counted over the full
 *     column;
 *   - no outlier proposal is made for non-number columns (Req 2.5);
 *   - the full-column count differs from (and is larger than) what the bounded
 *     samples alone would show.
 *
 * ## Environment note (same pattern as sample-reader.test.ts)
 *
 * DuckDB-WASM's browser bundles need a real browser worker environment that is
 * unavailable under Vitest's jsdom runner, so this test wraps the node-blocking
 * bundle in a DuckDBConnectionAdapter and injects it via createDuckDBService.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ColumnSchema } from "../types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { createSampleReader } from "./sample-reader";
import { cleanTables } from "./cleaning-rules";
import type { CleaningProposal } from "./types";

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs") as {
  createDuckDB: (
    bundles: unknown,
    logger: unknown,
    runtime: unknown,
  ) => Promise<DuckDBNodeInstance>;
  NODE_RUNTIME: unknown;
  VoidLogger: new () => unknown;
  DuckDBAccessMode: { READ_WRITE: number };
};

interface DuckDBConnectionLike {
  query(text: string): { toArray(): Array<{ toJSON(): Record<string, unknown> }> };
  close(): void;
}

interface DuckDBNodeInstance {
  instantiate(): Promise<unknown>;
  open(config: { path?: string; accessMode?: number }): void;
  connect(): DuckDBConnectionLike;
  reset(): void;
}

const DUCKDB_DIST = path.dirname(
  require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"),
);

const bundles = {
  mvp: {
    mainModule: path.join(DUCKDB_DIST, "duckdb-mvp.wasm"),
    mainWorker: path.join(DUCKDB_DIST, "duckdb-node-mvp.worker.cjs"),
  },
};

async function createNodeAdapter(): Promise<{
  adapter: DuckDBConnectionAdapter;
  dispose: () => void;
}> {
  const db = await duckdb.createDuckDB(
    bundles,
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  db.open({ path: ":memory:", accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  const conn = db.connect();
  const adapter: DuckDBConnectionAdapter = {
    async run(sql: string) {
      return conn.query(sql).toArray().map((r) => r.toJSON());
    },
  };
  return {
    adapter,
    dispose: () => {
      conn.close();
      db.reset();
    },
  };
}

function byKind(
  proposals: CleaningProposal[],
  kind: CleaningProposal["kind"]
): CleaningProposal[] {
  return proposals.filter((p) => p.kind === kind);
}

describe("cleaning rules over a real DuckDB (full-column counts)", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterAll(() => {
    dispose?.();
  });

  it("flags duplicate rows from a full-table count with normalized grouping (Req 2.3)", async () => {
    const service = createDuckDBService(adapter);
    await service.init();

    const schema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "kind", type: "string" },
    ];
    // "Ghoul" / "ghoul " / " ghoul" differ only by case/whitespace on name,
    // so with normalized grouping rows 1–3 collapse to one group (2 dups).
    // Rows 4–5 are exact duplicates (1 dup). Row 6 is unique.
    const rows = [
      ["Ghoul", "undead"],
      ["ghoul", "undead"], // case-only dup of row 1 after normalization? No:
      [" Ghoul ", "undead"], // whitespace dup of row 1 after normalization.
      ["Wraith", "spirit"],
      ["Wraith", "spirit"], // exact dup of row 4.
      ["Ogre", "giant"],
    ];
    await service.createTable("dups", schema, rows);

    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "dups",
      schema,
      rowCount: rows.length,
    });

    const proposals = await cleanTables(service, [sample]);
    const dup = byKind(proposals, "duplicate-rows")[0];
    expect(dup).toBeDefined();
    expect(dup.target).toEqual({ tableName: "dups" });

    // Normalized groups: {Ghoul,  Ghoul } (whitespace) → 1 removed;
    // "ghoul" lowercases differently from "Ghoul" under the string key
    // (trim/collapse only, not case), so it stays distinct. Wraith exact dup
    // → 1 removed. Total removed = 2, so 6 → 4.
    expect(dup.before).toEqual({ rowCount: 6 });
    expect(dup.after).toEqual({ rowCount: 4 });
    expect(dup.reason).toMatch(/duplicate/i);
    expect(dup.reason).not.toContain("\n");
  });

  it("does not flag duplicates when every row is unique", async () => {
    const service = createDuckDBService(adapter);
    const schema: ColumnSchema[] = [{ name: "name", type: "string" }];
    const rows = [["a"], ["b"], ["c"]];
    await service.createTable("uniq", schema, rows);
    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "uniq",
      schema,
      rowCount: rows.length,
    });
    const proposals = await cleanTables(service, [sample]);
    expect(byKind(proposals, "duplicate-rows")).toEqual([]);
  });

  it("flags number-column outliers from full-column Tukey fences (Req 2.5, 2.6)", async () => {
    const service = createDuckDBService(adapter);
    const schema: ColumnSchema[] = [{ name: "weight", type: "number" }];
    // A tight cluster 10..19 plus two extreme outliers.
    const base = Array.from({ length: 10 }, (_, i) => [String(10 + i)]);
    const rows = [...base, ["1000"], ["-500"]];
    await service.createTable("measurements", schema, rows);

    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "measurements",
      schema,
      rowCount: rows.length,
    });

    const proposals = await cleanTables(service, [sample]);
    const outlier = byKind(proposals, "outliers")[0];
    expect(outlier).toBeDefined();
    expect(outlier.target).toEqual({
      tableName: "measurements",
      columnName: "weight",
    });
    // Both extremes are beyond Q3 + 1.5·IQR / below Q1 − 1.5·IQR.
    expect(outlier.after).toMatchObject({ outliersFlagged: 2 });
    expect(outlier.before).toMatchObject({ outliersFlagged: 0 });
    expect(outlier.reason).toMatch(/outlier/i);
    expect(outlier.reason).not.toContain("\n");
  });

  it("never proposes outliers for non-number columns (Req 2.5)", async () => {
    const service = createDuckDBService(adapter);
    const schema: ColumnSchema[] = [{ name: "label", type: "string" }];
    const rows = [["a"], ["b"], ["a"], ["z"]];
    await service.createTable("labels", schema, rows);
    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "labels",
      schema,
      rowCount: rows.length,
    });
    const proposals = await cleanTables(service, [sample]);
    expect(byKind(proposals, "outliers")).toEqual([]);
  });

  it("counts outliers over the full column, not just the bounded samples", async () => {
    const service = createDuckDBService(adapter);
    const schema: ColumnSchema[] = [{ name: "v", type: "number" }];
    // Many repeats of one extreme so the full-column count exceeds what the
    // distinct-sample set alone (one distinct value) would suggest.
    const normal = Array.from({ length: 20 }, () => ["50"]);
    const outliers = Array.from({ length: 5 }, () => ["100000"]);
    const rows = [...normal, ...outliers];
    await service.createTable("skewed", schema, rows);
    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "skewed",
      schema,
      rowCount: rows.length,
    });

    const proposals = await cleanTables(service, [sample]);
    const outlier = byKind(proposals, "outliers")[0];
    expect(outlier).toBeDefined();
    // Full-column count = 5 outlier rows, even though only 1 distinct outlier
    // value exists in the samples.
    expect(outlier.after).toMatchObject({ outliersFlagged: 5 });
  });

  it("is idempotent in count: re-running clean on the same table yields identical proposals", async () => {
    const service = createDuckDBService(adapter);
    const schema: ColumnSchema[] = [{ name: "name", type: "string" }];
    const rows = [["a"], ["a"], ["b"]];
    await service.createTable("idem", schema, rows);
    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "idem",
      schema,
      rowCount: rows.length,
    });
    const first = await cleanTables(service, [sample]);
    const second = await cleanTables(service, [sample]);
    expect(second).toEqual(first);
  });
});
