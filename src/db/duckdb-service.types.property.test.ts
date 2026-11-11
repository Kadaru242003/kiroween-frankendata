/**
 * Property-based test for DuckDB table uses inferred types.
 *
 * Feature: frankendata-file-intake, Property 24: DuckDB table uses inferred types
 *
 * Validates: Requirements 6.5
 *
 * Property 24 statement: For any loaded table, each column's DuckDB column type
 * matches the `ColumnType` produced by the TypeInferenceLayer — i.e. the table
 * is created with explicit typed columns (via `CREATE TABLE "name" (col TYPE,
 * …)`), not via DuckDB's `CREATE TABLE … AS SELECT` auto-typing (Req 6.5).
 *
 * ## How the property is checked
 *
 * We drive {@link createDuckDBService} with an injected node-blocking DuckDB
 * connection adapter (the same headless setup the smoke test uses, since the
 * browser bundle needs a real worker environment unavailable under Vitest).
 * For each generated small schema + a few type-valid rows, we `createTable`
 * and then read the *actual* column types DuckDB recorded from
 * `information_schema.columns`. We assert each actual type equals
 * {@link COLUMN_TYPE_TO_DUCKDB_TYPE} for the inferred `ColumnType`.
 *
 * Because every generated value is valid for its column's type, no string
 * fallback is triggered, so the schema used is exactly the inferred one and
 * `loaded.schema` must equal the generated schema.
 *
 * ## DuckDB type-name normalization
 *
 * `information_schema.columns.data_type` reports DuckDB's canonical names. For
 * the four types we use these are reported verbatim as `DOUBLE`, `BOOLEAN`,
 * `DATE`, and `VARCHAR`, so no synonym mapping is strictly required. To stay
 * robust against DuckDB reporting common synonyms (e.g. `DOUBLE PRECISION` for
 * `DOUBLE`, `BOOL` for `BOOLEAN`, `TEXT`/`STRING` for `VARCHAR`), the actual
 * type is normalized through {@link normalizeDuckDbType} before comparison.
 *
 * ## Performance
 *
 * DuckDB table creation is comparatively expensive, so a single in-memory
 * instance is shared across all runs (`beforeAll`) and each iteration creates
 * a uniquely-named table. Generated tables are intentionally small (1–4
 * columns, 0–4 rows) and `numRuns` is kept at the 100 minimum, with a generous
 * suite timeout.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  COLUMN_TYPE_TO_DUCKDB_TYPE,
  type CellValue,
  type ColumnSchema,
  type ColumnType,
} from "../core/types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "./duckdb-service";

const NUM_RUNS = 100;
// DuckDB table creation per run is relatively expensive; give the whole suite
// headroom even though each generated table is tiny.
const SUITE_TIMEOUT_MS = 120_000;

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs") as {
  createDuckDB: (
    bundles: unknown,
    logger: unknown,
    runtime: unknown
  ) => Promise<DuckDBNodeInstance>;
  NODE_RUNTIME: unknown;
  VoidLogger: new () => unknown;
  DuckDBAccessMode: { READ_WRITE: number };
};

interface DuckDBConnectionLike {
  query(text: string): {
    toArray(): Array<{ toJSON(): Record<string, unknown> }>;
  };
  close(): void;
}

interface DuckDBNodeInstance {
  instantiate(): Promise<unknown>;
  open(config: { path?: string; accessMode?: number }): void;
  connect(): DuckDBConnectionLike;
  reset(): void;
}

const DUCKDB_DIST = path.dirname(
  require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs")
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
    duckdb.NODE_RUNTIME
  );
  await db.instantiate();
  db.open({
    path: ":memory:",
    accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
  });
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

/**
 * Normalize a DuckDB `information_schema.columns.data_type` value to the
 * canonical name used in {@link COLUMN_TYPE_TO_DUCKDB_TYPE}. DuckDB reports the
 * four types we use as `DOUBLE`/`BOOLEAN`/`DATE`/`VARCHAR`; the extra synonym
 * folding guards against DuckDB reporting an equivalent spelling.
 */
function normalizeDuckDbType(dataType: string): string {
  const upper = dataType.trim().toUpperCase();
  switch (upper) {
    case "DOUBLE PRECISION":
    case "FLOAT8":
      return "DOUBLE";
    case "BOOL":
      return "BOOLEAN";
    case "TEXT":
    case "STRING":
    case "CHAR":
      return "VARCHAR";
    default:
      return upper;
  }
}

const COLUMN_TYPES: readonly ColumnType[] = [
  "number",
  "boolean",
  "date",
  "string",
];

/** A valid-identifier column name (letter-led, unique via index suffix). */
function columnName(index: number): string {
  return `c${index}`;
}

/** A value generator yielding values VALID for the given column type so that
 *  no string fallback is triggered. `null` is allowed for every type. */
function valueArbForType(type: ColumnType): fc.Arbitrary<CellValue> {
  const nullish = fc.constant<CellValue>(null);
  switch (type) {
    case "number":
      // Numeric strings in shapes parseNumber round-trips exactly.
      return fc.oneof(
        nullish,
        fc
          .integer({ min: -100000, max: 100000 })
          .map((n) => String(n)),
        fc
          .float({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
          .map((n) => n.toString())
      );
    case "boolean":
      return fc.oneof(
        nullish,
        fc.constantFrom<CellValue>("true", "false", "yes", "no", "TRUE", "No")
      );
    case "date":
      return fc.oneof(
        nullish,
        fc.constantFrom<CellValue>(
          "2026-01-05",
          "01/05/2026",
          "31-12-2025",
          "Jan 5, 2026",
          "1999-12-31"
        )
      );
    case "string":
    default:
      return fc.oneof(nullish, fc.string({ maxLength: 16 }));
  }
}

/**
 * Generate a small schema (1–4 columns, each a random ColumnType with a unique
 * valid identifier name) plus a few rows whose cells are valid for each
 * column's type.
 */
const schemaAndRows = fc
  .array(fc.constantFrom<ColumnType>(...COLUMN_TYPES), {
    minLength: 1,
    maxLength: 4,
  })
  .chain((types) => {
    const schema: ColumnSchema[] = types.map((type, i) => ({
      name: columnName(i),
      type,
    }));
    const rowArb = fc.tuple(
      ...types.map((type) => valueArbForType(type))
    ) as fc.Arbitrary<CellValue[]>;
    return fc.record({
      schema: fc.constant(schema),
      rows: fc.array(rowArb, { minLength: 0, maxLength: 4 }),
    });
  });

describe("Property 24: DuckDB table uses inferred types", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;
  let tableCounter = 0;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  }, SUITE_TIMEOUT_MS);

  afterAll(() => {
    dispose?.();
  });

  it(
    "creates each column with the DuckDB type mapped from its inferred ColumnType",
    async () => {
      const service = createDuckDBService(adapter);
      await service.init(); // no-op when a connection is injected

      await fc.assert(
        fc.asyncProperty(schemaAndRows, async ({ schema, rows }) => {
          // Unique table name per iteration avoids collisions across runs.
          const tableName = `t_prop24_${tableCounter++}`;

          const loaded = await service.createTable(tableName, schema, rows);

          // Every value was valid for its column's type, so no string fallback
          // occurred: the schema used must equal the inferred schema.
          expect(loaded.schema).toEqual(schema);

          // Read the ACTUAL column types DuckDB recorded. Using the catalog
          // (not inference of the inserted data) proves explicit typed DDL.
          const actual = await service.query<{
            column_name: string;
            data_type: string;
          }>(
            `SELECT column_name, data_type FROM information_schema.columns ` +
              `WHERE table_name = '${tableName}'`
          );

          const actualByName = new Map(
            actual.map((r) => [r.column_name, normalizeDuckDbType(r.data_type)])
          );

          // One catalog entry per schema column, each matching the mapping.
          expect(actualByName.size).toBe(schema.length);
          for (const col of schema) {
            expect(actualByName.get(col.name)).toBe(
              COLUMN_TYPE_TO_DUCKDB_TYPE[col.type]
            );
          }
        }),
        { numRuns: NUM_RUNS }
      );
    },
    SUITE_TIMEOUT_MS
  );
});
