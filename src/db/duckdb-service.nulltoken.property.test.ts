/**
 * Property-based test for NullToken exclusion from inference and NULL storage.
 *
 * Feature: frankendata-file-intake, Property 12: NullToken exclusion and NULL storage
 *
 * Validates: Requirements 5.2
 *
 * Property 12 statement: For any column, every NullToken (an empty/whitespace
 * cell, or the text `N/A`, `NA`, `null`, or a single hyphen `-`, matched
 * case-insensitively after trimming) is excluded from type inference and
 * stored as SQL NULL. This has two halves, both exercised here end-to-end:
 *
 *   1. EXCLUSION from inference: a column of type-valid values with some
 *      NullTokens interleaved still infers to the underlying type (number /
 *      boolean / date), never degrading to string merely because NullTokens are
 *      present (the all-NullToken case is `string` by Req 5.9 and is handled
 *      separately as the string-column case here).
 *   2. NULL storage: `DuckDBService.createTable` stores every NullToken cell as
 *      SQL NULL, for ALL four column types — including string columns, where a
 *      NullToken such as `N/A` must be stored as NULL rather than the literal
 *      text (Req 5.2). Every non-NullToken valid value must round-trip as a
 *      non-null value.
 *
 * ## Under test
 *
 * - Inference: {@link typeInferenceLayer}.infer (`../core/type-inference`).
 * - Storage: {@link createDuckDBService} over a node-blocking DuckDB adapter.
 *
 * Expected NULL positions are computed independently via {@link isNullToken}
 * (`../core/predicates`) — the same predicate the service uses — so the test
 * asserts the service agrees with the specification's own definition.
 *
 * ## Environment / performance notes
 *
 * As with the smoke test, DuckDB-WASM's *browser* bundles need a real browser
 * worker environment unavailable under Vitest, so this test wraps the
 * *node-blocking* bundle (same engine, synchronous API, filesystem-located
 * assets) in a `DuckDBConnectionAdapter` and injects it into the service.
 *
 * The DuckDB instance is instantiated ONCE for the whole file (init is the
 * expensive part) and shared across all fast-check runs; each run creates a
 * fresh, uniquely-named table so runs never collide. Read-back goes through
 * `getPreviewRows` (SELECT *), and DuckDB returns a SQL NULL as JS `null` via
 * the adapter's `row.toJSON()`, so per-cell null-ness is compared as
 * `value === null`.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { isNullToken } from "../core/predicates";
import { typeInferenceLayer } from "../core/type-inference";
import type { CellValue, ColumnType } from "../core/types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "./duckdb-service";

const NUM_RUNS = 100;

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs") as {
  createDuckDB: (bundles: unknown, logger: unknown, runtime: unknown) => Promise<DuckDBNodeInstance>;
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

/** Create a single in-memory node-blocking connection adapter + a disposer. */
async function createNodeAdapter(): Promise<{
  adapter: DuckDBConnectionAdapter;
  dispose: () => void;
}> {
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
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

/**
 * The full catalogue of NullToken spellings: `null` (the JS value), empty and
 * whitespace-only strings, and `N/A`/`NA`/`null`/`-` with varied casing and
 * surrounding whitespace. Every one of these must be excluded from inference
 * and stored as SQL NULL.
 */
const nullTokenCell: fc.Arbitrary<CellValue> = fc.constantFrom<CellValue>(
  null,
  "",
  "   ",
  "\t",
  " \n ",
  "N/A",
  "n/a",
  "  N/A  ",
  "NA",
  "na",
  "null",
  "NULL",
  "  null ",
  "-",
  " - ",
);

/**
 * Per-type arbitraries for *valid*, non-NullToken values. The string case
 * deliberately avoids values that `isNullToken` would catch (and avoids
 * embedded quotes only incidentally — the service escapes those anyway) so the
 * generated "present" values are genuinely non-null.
 */
const validValueByType: Record<ColumnType, fc.Arbitrary<string>> = {
  number: fc.oneof(
    fc.integer({ min: -100000, max: 100000 }).map((n) => String(n)),
    fc.float({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
      .map((n) => n.toFixed(2)),
    fc.constantFrom("$1,234.56", "12%", "-3.14", "1e3", "0", "42"),
  ),
  boolean: fc.constantFrom("true", "false", "yes", "no", "TRUE", "No", "Yes"),
  date: fc.constantFrom(
    "2026-01-05",
    "01/05/2026",
    "05-01-2026",
    "Jan 5, 2026",
    "2024-02-29",
    "12/31/1999",
  ),
  string: fc
    .string({ minLength: 1, maxLength: 12 })
    // Keep generated "present" string values genuinely non-null: exclude any
    // value the spec would treat as a NullToken (e.g. a stray "-" or "na").
    .filter((s) => !isNullToken(s)),
};

const COLUMN_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/**
 * A cell for a column of the given type: either a NullToken (weighted so most
 * rows have at least one) or a type-valid present value. For string columns the
 * "valid" value is also sometimes a NullToken-shaped text to confirm it is
 * stored as NULL rather than the literal (handled by the NullToken branch).
 */
function cellForType(type: ColumnType): fc.Arbitrary<CellValue> {
  return fc.oneof(
    { weight: 2, arbitrary: nullTokenCell },
    { weight: 3, arbitrary: validValueByType[type] as fc.Arbitrary<CellValue> },
  );
}

/**
 * A small table: one column per type (so every type is exercised each run),
 * plus a handful of rows. Each cell is independently a NullToken or a valid
 * value for its column's type.
 */
const tableArb = fc
  .record({
    // A permutation/subset of the four types, length 1..4, always including at
    // least one column. Using the fixed four keeps every type covered.
    types: fc.constant(COLUMN_TYPES),
    rowCount: fc.integer({ min: 1, max: 6 }),
  })
  .chain(({ types, rowCount }) =>
    fc.record({
      types: fc.constant(types),
      rows: fc.array(
        fc.tuple(...types.map((t) => cellForType(t))) as fc.Arbitrary<CellValue[]>,
        { minLength: rowCount, maxLength: rowCount },
      ),
    }),
  );

// ---------------------------------------------------------------------------
// Shared DuckDB instance
// ---------------------------------------------------------------------------

let adapter: DuckDBConnectionAdapter;
let dispose: () => void;
let service: ReturnType<typeof createDuckDBService>;
let tableCounter = 0;

beforeAll(async () => {
  const created = await createNodeAdapter();
  adapter = created.adapter;
  dispose = created.dispose;
  service = createDuckDBService(adapter);
  await service.init(); // no-op when a connection is injected
});

afterAll(() => {
  dispose?.();
});

/** A unique, valid DuckDB identifier per table so runs never collide. */
function uniqueTableName(): string {
  return `nulltok_${tableCounter++}`;
}

describe("Property 12: NullToken exclusion and NULL storage", () => {
  it(
    "excludes NullTokens from inference and stores them as SQL NULL for all column types",
    async () => {
      await fc.assert(
        fc.asyncProperty(tableArb, async ({ types, rows }) => {
          const columnNames = types.map((t, i) => `c${i}_${t}`);

          // --- Half 1: exclusion from inference ---
          // Columns that have at least one non-NullToken value should infer to
          // the underlying type (NullTokens are ignored). A column that happens
          // to be all NullTokens for this run infers to string (Req 5.9).
          const schema = typeInferenceLayer.infer(columnNames, rows);
          expect(schema).toHaveLength(columnNames.length);

          for (let col = 0; col < types.length; col++) {
            const columnValues = rows.map((r) => r[col]);
            const present = columnValues.filter((v) => !isNullToken(v));
            if (present.length > 0 && types[col] !== "string") {
              // Exclusion: NullTokens didn't push a valid-typed column to string.
              expect(schema[col].type).toBe(types[col]);
            }
          }

          // --- Half 2: NULL storage in DuckDB ---
          const tableName = uniqueTableName();
          const loaded = await service.createTable(tableName, schema, rows);
          expect(loaded.rowCount).toBe(rows.length);

          const preview = await service.getPreviewRows(tableName, rows.length + 5);
          expect(preview).toHaveLength(rows.length);

          // For every cell, compare DB null-ness against isNullToken: a
          // NullToken must be NULL (JS null); a non-NullToken value must be
          // present (non-null) regardless of the column's final type.
          for (let r = 0; r < rows.length; r++) {
            for (let col = 0; col < columnNames.length; col++) {
              const original = rows[r][col];
              const readBack = preview[r][schema[col].name];
              if (isNullToken(original)) {
                expect(readBack).toBeNull();
              } else {
                // A non-NullToken valid value is stored and read back non-null.
                expect(readBack).not.toBeNull();
                expect(readBack).not.toBeUndefined();
              }
            }
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    120_000,
  );

  it(
    "stores a NullToken in a string column as NULL, not the literal text",
    async () => {
      // Targeted example: a string-typed column whose cells mix a genuine
      // string with NullToken-shaped texts. Per Req 5.2 the NullTokens must be
      // NULL even though the column type is string.
      const schema = [{ name: "label", type: "string" as const }];
      const rows: CellValue[][] = [
        ["alpha"],
        ["N/A"],
        ["na"],
        ["-"],
        ["null"],
        [""],
        ["   "],
        [null],
        ["beta"],
      ];
      const tableName = uniqueTableName();
      await service.createTable(tableName, schema, rows);
      const preview = await service.getPreviewRows(tableName, 50);

      expect(preview.map((r) => r.label)).toEqual([
        "alpha",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "beta",
      ]);
    },
    120_000,
  );
});
