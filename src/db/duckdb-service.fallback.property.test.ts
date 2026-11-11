/**
 * Property-based test for string fallback on conversion failure.
 *
 * Feature: frankendata-file-intake, Property 26: String fallback on conversion failure
 *
 * Validates: Requirements 6.7
 *
 * Property 26 statement: If converting a column's values to its inferred
 * DuckDB type fails during loading, that column is loaded as `VARCHAR`
 * (string) and the file still loads — no `table-load-failed` error is thrown
 * for that reason. The returned {@link LoadedTable}'s schema reflects
 * `"string"` for the demoted column, while columns whose values ARE valid for
 * their inferred type keep that type (no spurious fallback).
 *
 * ## How the conversion failure is triggered (matching the implementation)
 *
 * `DuckDBService.createTable` → `loadTable` → `coerceWithFallback` coerces each
 * column's cells to a typed SQL literal via `toSqlLiteral` BEFORE any DDL/DML
 * runs. For a non-string declared type the coercion throws on an invalid cell:
 *   - `number`  → `parseNumber` throws `RangeError` on non-numeric text;
 *   - `boolean` → anything other than true/false/yes/no throws `RangeError`;
 *   - `date`    → `normalizeDateToIso` throws `RangeError` on a non-date.
 * The first throw demotes that column to `"string"` (mutating the effective
 * schema) and re-coerces all its values as `VARCHAR` — the string fallback.
 * NullTokens (incl. the JS `null`) never trigger a failure: they coerce to SQL
 * `NULL` for every type. So to force a fallback for a column declared `T`
 * (a non-string type) we plant at least one non-null value that `T`'s coercion
 * rejects (e.g. `"abc"` in a `number` column).
 *
 * As with the smoke test, DuckDB-WASM's *browser* bundles need a real browser
 * worker environment unavailable under Vitest, so this test wraps the
 * *node-blocking* bundle (same engine, synchronous API, filesystem-located
 * assets) in a DuckDBConnectionAdapter and injects it. The adapter is created
 * once for the whole suite (init-once) and reused across runs; each generated
 * case uses a unique table name to avoid DDL collisions.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { IntakeFailure } from "../core/intake-failure";
import type { CellValue, ColumnType } from "../core/types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "./duckdb-service";

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

/** Create an in-memory node-blocking connection adapter + a disposer. */
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

const NUM_RUNS = 100;

/**
 * A non-string column type whose coercion can fail — the candidate for
 * fallback. (`string` is excluded because its coercion is total and can never
 * trigger a fallback.)
 */
const failableType: fc.Arbitrary<Exclude<ColumnType, "string">> =
  fc.constantFrom("number", "boolean", "date");

/** A null-token cell: coerces to SQL NULL for every type, never a failure. */
const nullTokenCell: fc.Arbitrary<CellValue> = fc.constantFrom<CellValue>(
  null,
  "",
  "  ",
  "N/A",
  "na",
  "null",
  "-",
  " NULL ",
);

/** A value that is VALID for the given type (coerces cleanly, no fallback). */
function validValueFor(type: Exclude<ColumnType, "string">): fc.Arbitrary<string> {
  switch (type) {
    case "number":
      return fc.constantFrom("42", "-3.14", "0", "1,234.56", "$10", "12%", "1e3");
    case "boolean":
      return fc.constantFrom("true", "false", "yes", "no", "TRUE", "Yes", "No");
    case "date":
      return fc.constantFrom(
        "2026-01-05",
        "01/05/2026",
        "05-01-2026",
        "Jan 5, 2026",
      );
  }
}

/**
 * A value that is INVALID for the given type — its coercion throws, forcing
 * the string fallback. These are deliberately non-null (null tokens never
 * fail) and are NOT accepted by the type's coercion step.
 */
function invalidValueFor(type: Exclude<ColumnType, "string">): fc.Arbitrary<string> {
  switch (type) {
    case "number":
      // Non-numeric text parseNumber rejects.
      return fc.constantFrom("abc", "not-a-number", "12x", "$$", "hello world");
    case "boolean":
      // Not true/false/yes/no — and not a null token.
      return fc.constantFrom("maybe", "1", "0", "truthy", "sometimes");
    case "date":
      // Not a recognized/valid calendar date.
      return fc.constantFrom("not-a-date", "2026-13-40", "99/99/9999", "xyz");
  }
}

/** Unique table-name counter so every generated case gets a fresh table. */
let tableCounter = 0;
function nextTableName(tag: string): string {
  tableCounter += 1;
  return `${tag}_${tableCounter}`;
}

describe("Property 26: String fallback on conversion failure", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeAll(async () => {
    const created = await createNodeAdapter();
    adapter = created.adapter;
    dispose = created.dispose;
  });

  afterAll(() => {
    dispose?.();
  });

  it(
    "demotes a column with unconvertible values to VARCHAR and still loads the file",
    async () => {
      /**
       * A two-column table:
       *   - col `bad`: declared as a failable type but containing at least one
       *     value that the type's coercion rejects → must fall back to string;
       *   - col `good`: declared as a (possibly different) failable type with
       *     ONLY valid values → must keep its inferred type (no spurious
       *     fallback). This verifies the per-column nature of the fallback.
       */
      const scenario = fc
        .record({
          badType: failableType,
          goodType: failableType,
        })
        .chain(({ badType, goodType }) =>
          fc.record({
            badType: fc.constant(badType),
            goodType: fc.constant(goodType),
            // At least one invalid value for `bad` (guaranteeing a failure),
            // interleaved with nulls and valid values that would NOT by
            // themselves trigger a fallback.
            badValues: fc
              .array(
                fc.oneof(
                  invalidValueFor(badType),
                  validValueFor(badType),
                  nullTokenCell,
                ),
                { minLength: 0, maxLength: 5 },
              )
              .chain((rest) =>
                // Insert a guaranteed invalid value at an arbitrary index so
                // the column coercion is guaranteed to fail somewhere.
                invalidValueFor(badType).chain((bad) =>
                  fc
                    .integer({ min: 0, max: rest.length })
                    .map((idx) => {
                      const copy = rest.slice();
                      copy.splice(idx, 0, bad);
                      return copy as CellValue[];
                    }),
                ),
              ),
            // `good` column values: only valid-or-null, so it must NOT fall back.
            goodValueKinds: fc.array(fc.boolean(), { minLength: 0, maxLength: 6 }),
          }),
        )
        .chain((s) =>
          // Build the `good` column to the SAME length as `bad`, each cell
          // either a valid value or a null token (both coerce cleanly).
          fc
            .array(fc.oneof(validValueFor(s.goodType), nullTokenCell), {
              minLength: s.badValues.length,
              maxLength: s.badValues.length,
            })
            .map((goodValues) => ({
              badType: s.badType,
              goodType: s.goodType,
              badValues: s.badValues,
              goodValues: goodValues as CellValue[],
            })),
        );

      await fc.assert(
        fc.asyncProperty(scenario, async ({ badType, goodType, badValues, goodValues }) => {
          const service = createDuckDBService(adapter);

          const schema = [
            { name: "bad", type: badType },
            { name: "good", type: goodType },
          ];
          const rows: CellValue[][] = badValues.map((b, i) => [b, goodValues[i]]);
          const tableName = nextTableName("fallback");

          // The file still loads: createTable RESOLVES (no table-load-failed).
          const loaded = await service.createTable(tableName, schema, rows);

          // The failing column was demoted to string (fallback applied).
          const badCol = loaded.schema.find((c) => c.name === "bad");
          expect(badCol?.type).toBe("string");

          // The valid column kept its inferred type (no spurious fallback).
          const goodCol = loaded.schema.find((c) => c.name === "good");
          expect(goodCol?.type).toBe(goodType);

          // Row count preserved: all parsed rows loaded.
          expect(loaded.rowCount).toBe(rows.length);
          expect(await service.getRowCount(tableName)).toBe(rows.length);

          // The demoted column's DuckDB type is VARCHAR; the good column's
          // DuckDB type is NOT VARCHAR (it kept its inferred non-string type).
          const cols = await service.query<{ column_name: string; column_type: string }>(
            `SELECT column_name, column_type FROM (DESCRIBE ${quoteIdent(tableName)})`,
          );
          const colType = (name: string) =>
            cols.find((c) => c.column_name === name)?.column_type;
          expect(colType("bad")).toBe("VARCHAR");
          expect(colType("good")).not.toBe("VARCHAR");

          // The previously-invalid values are present as strings: every
          // non-null `bad` cell round-trips to its original text.
          const preview = await service.getPreviewRows(tableName, rows.length);
          for (let i = 0; i < rows.length; i++) {
            const original = badValues[i];
            const stored = preview[i]?.bad;
            if (original === null || isNullTokenText(original)) {
              expect(stored).toBeNull();
            } else {
              expect(stored).toBe(original);
            }
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    120_000,
  );

  it(
    "does not spuriously fall back: a column of only-valid values keeps its inferred type",
    async () => {
      const scenario = failableType.chain((type) =>
        fc.record({
          type: fc.constant(type),
          values: fc.array(fc.oneof(validValueFor(type), nullTokenCell), {
            minLength: 1,
            maxLength: 8,
          }),
        }),
      );

      await fc.assert(
        fc.asyncProperty(scenario, async ({ type, values }) => {
          const service = createDuckDBService(adapter);
          const schema = [{ name: "v", type }];
          const rows: CellValue[][] = values.map((v) => [v]);
          const tableName = nextTableName("sanity");

          const loaded = await service.createTable(tableName, schema, rows);

          // No fallback: the inferred type is preserved.
          expect(loaded.schema[0].type).toBe(type);
          expect(loaded.rowCount).toBe(rows.length);

          const cols = await service.query<{ column_name: string; column_type: string }>(
            `SELECT column_name, column_type FROM (DESCRIBE ${quoteIdent(tableName)})`,
          );
          expect(cols.find((c) => c.column_name === "v")?.column_type).not.toBe("VARCHAR");
        }),
        { numRuns: NUM_RUNS },
      );
    },
    120_000,
  );

  it("never throws a table-load-failed IntakeFailure for the fallback case", async () => {
    // A direct, deterministic check that the fallback path resolves rather
    // than surfacing Req 6.8's table-load-failed error.
    const service = createDuckDBService(adapter);
    const schema = [{ name: "n", type: "number" as ColumnType }];
    const rows: CellValue[][] = [["1"], ["abc"], ["-"]];
    const tableName = nextTableName("nothrow");

    let error: unknown = null;
    try {
      const loaded = await service.createTable(tableName, schema, rows);
      expect(loaded.schema[0].type).toBe("string");
      expect(loaded.rowCount).toBe(3);
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
    expect(error).not.toBeInstanceOf(IntakeFailure);
  });
});

/** Quote a SQL identifier (table/column name) by doubling embedded double quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Mirror the service's NullToken recognition (`isNullToken`) for asserting
 * which `bad` cells become SQL NULL after fallback: empty/whitespace, and the
 * texts `n/a`, `na`, `null`, `-` (case-insensitive after trim).
 */
function isNullTokenText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return true;
  }
  return new Set(["n/a", "na", "null", "-"]).has(trimmed.toLowerCase());
}
