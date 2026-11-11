/**
 * Property-based test for row count preservation in the DuckDBService.
 *
 * Feature: frankendata-file-intake, Property 25: Row count preservation
 *
 * Validates: Requirements 6.6
 *
 * Property 25 statement: For any parsed file, the number of rows inserted into
 * the DuckDB table equals the number of parsed data rows. Concretely, for a
 * generated schema and N data rows, `createTable(name, schema, rows)` returns a
 * {@link LoadedTable} whose `rowCount === N`, and querying the live DB
 * (`getRowCount` / `SELECT COUNT(*)`) also yields N — including the zero-row
 * edge case (N = 0 produces an empty table with 0 rows).
 *
 * The service asserts internally that the inserted row count equals the parsed
 * row count (and raises `table-load-failed` otherwise); this test confirms that
 * invariant end-to-end against a real in-memory DuckDB engine, regardless of
 * column types, cell values, nulls/NullTokens, or string fallback.
 *
 * ## Environment note (same pattern as duckdb-service.smoke.test.ts)
 *
 * DuckDB-WASM's *browser* bundles need a real browser worker environment that
 * is unavailable under Vitest's jsdom runner, so this test wraps the
 * *node-blocking* bundle (same DuckDB engine over WebAssembly, synchronous API,
 * filesystem-located Wasm/worker assets) in a {@link DuckDBConnectionAdapter}
 * and injects it via {@link createDuckDBService}. A single DuckDB instance is
 * created once in `beforeAll` and reused across every property iteration; each
 * iteration uses a unique table name so iterations never collide.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CellValue, ColumnSchema, ColumnType } from "../core/types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "./duckdb-service";

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

/** Create an in-memory node-blocking connection adapter + a disposer. */
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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const COLUMN_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/**
 * A valid, unique DuckDB column identifier: lowercase letter followed by
 * letters/digits/underscores. Kept simple so the only thing under test is row
 * count, not identifier quoting.
 */
const columnName = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.string({ minLength: 0, maxLength: 6 }).map((s) =>
      s.replace(/[^a-z0-9_]/gi, "").toLowerCase(),
    ),
  )
  .map(([head, tail]) => head + tail);

/** 1..4 columns with unique names and random types. */
const schemaArb: fc.Arbitrary<ColumnSchema[]> = fc
  .uniqueArray(columnName, { minLength: 1, maxLength: 4 })
  .chain((names) =>
    fc
      .tuple(
        ...names.map(() => fc.constantFrom<ColumnType>(...COLUMN_TYPES)),
      )
      .map((types) =>
        names.map((name, i) => ({ name, type: types[i] as ColumnType })),
      ),
  );

/** NullToken strings recognized by the service → stored as SQL NULL. */
const nullTokenArb = fc.constantFrom<CellValue>(
  null,
  "",
  "   ",
  "N/A",
  "na",
  "null",
  "-",
);

/**
 * A cell value that is VALID for `type` (coerces cleanly, so no string
 * fallback is forced — though row count must hold regardless). Also mixes in
 * null/NullToken values, which still count as rows (stored as NULL).
 */
function validCellArb(type: ColumnType): fc.Arbitrary<CellValue> {
  const valid: fc.Arbitrary<CellValue> = (() => {
    switch (type) {
      case "number":
        return fc
          .integer({ min: -100000, max: 100000 })
          .map((n) => String(n));
      case "boolean":
        return fc.constantFrom("true", "false", "yes", "no");
      case "date":
        return fc.constantFrom(
          "2026-01-05",
          "01/05/2026",
          "2024-12-31",
          "07/04/2020",
        );
      case "string":
      default:
        // Arbitrary text, but never a NullToken (nulls come from the other branch).
        return fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((s) => {
            const t = s.trim().toLowerCase();
            return t !== "" && t !== "n/a" && t !== "na" && t !== "null" && t !== "-";
          });
    }
  })();
  // ~1 in 4 cells is a null/NullToken; the rest are valid typed values.
  return fc.oneof(
    { weight: 3, arbitrary: valid },
    { weight: 1, arbitrary: nullTokenArb },
  );
}

/** N rows (0..30) of cells valid for the given schema. */
function rowsArb(schema: ColumnSchema[]): fc.Arbitrary<CellValue[][]> {
  const rowArb = fc.tuple(...schema.map((c) => validCellArb(c.type)));
  return fc.array(rowArb, { minLength: 0, maxLength: 30 }).map((rows) =>
    rows.map((r) => [...r]),
  );
}

/** A schema paired with rows valid for that schema. */
const schemaWithRowsArb = schemaArb.chain((schema) =>
  rowsArb(schema).map((rows) => ({ schema, rows })),
);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Property 25: Row count preservation", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterAll(() => {
    dispose?.();
  });

  it("inserts exactly as many rows as were parsed (incl. the zero-row edge)", async () => {
    const service = createDuckDBService(adapter);
    await service.init(); // no-op when a connection is injected

    let iteration = 0;

    await fc.assert(
      fc.asyncProperty(schemaWithRowsArb, async ({ schema, rows }) => {
        // Unique table name per iteration so iterations never collide.
        const tableName = `rc_${iteration++}`;
        const n = rows.length;

        const loaded = await service.createTable(tableName, schema, rows);

        // LoadedTable reports the parsed row count.
        expect(loaded.rowCount).toBe(n);

        // The live DB agrees, via the service helper …
        expect(await service.getRowCount(tableName)).toBe(n);

        // … and via a direct COUNT(*) query.
        const countRows = await service.query<{ c: number }>(
          `SELECT COUNT(*) AS c FROM "${tableName}"`,
        );
        expect(Number(countRows[0]?.c ?? -1)).toBe(n);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
