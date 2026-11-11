/**
 * SampleReader unit tests (Feature 2, task 4) — deterministic, frequency-
 * carrying per-column sampling against a real in-memory DuckDB instance.
 *
 * Covers the design's determinism contract (Req 2.9, 5.2):
 *   - ordering is count DESC then value ASC (the global tie-break);
 *   - NULLs are excluded from the returned matching sets;
 *   - each SampleValue carries its true frequency;
 *   - the LIMIT uses MAX_SAMPLE_VALUES_PER_COLUMN (not a hard-coded 200);
 *   - repeated reads of the same table are identical (determinism).
 *
 * ## Environment note (same pattern as duckdb-service.smoke.test.ts)
 *
 * DuckDB-WASM's *browser* bundles need a real browser worker environment that
 * is unavailable under Vitest's jsdom runner, so this test wraps the
 * *node-blocking* bundle (same DuckDB engine over WebAssembly, synchronous API,
 * filesystem-located Wasm/worker assets) in a DuckDBConnectionAdapter and
 * injects it via createDuckDBService.
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
import { MAX_SAMPLE_VALUES_PER_COLUMN } from "./types";

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

describe("SampleReader (deterministic, frequency-carrying)", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterAll(() => {
    dispose?.();
  });

  it("orders values by count DESC, then value ASC, carrying true frequencies", async () => {
    const service = createDuckDBService(adapter);
    await service.init(); // no-op when a connection is injected

    // category frequencies: ghoul×3, wraith×2, ogre×1, orc×1 (orc/ogre tie at 1).
    const schema: ColumnSchema[] = [{ name: "kind", type: "string" }];
    const rows = [
      ["ghoul"],
      ["ghoul"],
      ["ghoul"],
      ["wraith"],
      ["wraith"],
      ["orc"],
      ["ogre"],
    ];
    await service.createTable("creatures", schema, rows);

    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "creatures",
      schema,
      rowCount: rows.length,
    });

    // Count DESC first; the orc/ogre tie (both count 1) breaks on value ASC
    // → "ogre" before "orc".
    expect(sample.samplesByColumn.kind).toEqual([
      { value: "ghoul", count: 3 },
      { value: "wraith", count: 2 },
      { value: "ogre", count: 1 },
      { value: "orc", count: 1 },
    ]);
    expect(sample.rowCount).toBe(rows.length);
    expect(sample.tableName).toBe("creatures");
  });

  it("excludes NULLs from the matching set while counting non-null frequencies", async () => {
    const service = createDuckDBService(adapter);

    // "N/A" and "" are null tokens → stored as SQL NULL; only "x"/"y" remain.
    const schema: ColumnSchema[] = [{ name: "label", type: "string" }];
    const rows = [
      ["x"],
      ["x"],
      ["N/A"],
      [""],
      [null],
      ["y"],
    ];
    await service.createTable("with_nulls", schema, rows);

    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "with_nulls",
      schema,
      rowCount: rows.length,
    });

    // No null value appears in the returned set, and counts reflect only the
    // non-null occurrences.
    const samples = sample.samplesByColumn.label;
    expect(samples.every((s) => s.value !== null)).toBe(true);
    expect(samples).toEqual([
      { value: "x", count: 2 },
      { value: "y", count: 1 },
    ]);
  });

  it("bounds the distinct set to MAX_SAMPLE_VALUES_PER_COLUMN", async () => {
    const service = createDuckDBService(adapter);

    // One more distinct value than the cap; each appears once so the ORDER BY
    // falls entirely to the value-ASC tie-break, and the LIMIT keeps the first
    // MAX_SAMPLE_VALUES_PER_COLUMN by that ordering.
    const distinct = MAX_SAMPLE_VALUES_PER_COLUMN + 1;
    const schema: ColumnSchema[] = [{ name: "n", type: "number" }];
    const rows = Array.from({ length: distinct }, (_, i) => [String(i)]);
    await service.createTable("many", schema, rows);

    const reader = createSampleReader(service);
    const sample = await reader.readTable({
      tableName: "many",
      schema,
      rowCount: rows.length,
    });

    expect(sample.samplesByColumn.n).toHaveLength(
      MAX_SAMPLE_VALUES_PER_COLUMN,
    );
  });

  it("is deterministic: repeated reads of the same table are identical", async () => {
    const service = createDuckDBService(adapter);

    const schema: ColumnSchema[] = [
      { name: "a", type: "string" },
      { name: "b", type: "number" },
    ];
    const rows = [
      ["red", "1"],
      ["red", "1"],
      ["blue", "2"],
      ["green", "2"],
      ["green", "2"],
    ];
    await service.createTable("det", schema, rows);

    const reader = createSampleReader(service);
    const first = await reader.readTable({
      tableName: "det",
      schema,
      rowCount: rows.length,
    });
    const second = await reader.readTable({
      tableName: "det",
      schema,
      rowCount: rows.length,
    });

    expect(second).toEqual(first);
    // Spot-check the ordering within a column: red×2 and green×2 lead the
    // count-1 group (blue×1); within the count-2 group value ASC puts green
    // before red.
    expect(first.samplesByColumn.a).toEqual([
      { value: "green", count: 2 },
      { value: "red", count: 2 },
      { value: "blue", count: 1 },
    ]);
  });

  it("reads several tables in input order via readTables", async () => {
    const service = createDuckDBService(adapter);
    const schema: ColumnSchema[] = [{ name: "v", type: "string" }];
    await service.createTable("t_one", schema, [["a"]]);
    await service.createTable("t_two", schema, [["b"]]);

    const reader = createSampleReader(service);
    const samples = await reader.readTables([
      { tableName: "t_one", schema, rowCount: 1 },
      { tableName: "t_two", schema, rowCount: 1 },
    ]);

    expect(samples.map((s) => s.tableName)).toEqual(["t_one", "t_two"]);
  });
});
