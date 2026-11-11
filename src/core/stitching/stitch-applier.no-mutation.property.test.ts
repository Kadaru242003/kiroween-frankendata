/**
 * Property 5 — Apply never mutates originals (DuckDB-backed).
 *
 * Feature: frankendata-ai-stitching, Design Property 5 ("Apply never mutates
 * originals" / the "never touch originals" invariant, design: "Apply and Undo
 * in DuckDB").
 *
 * **Validates: Requirements 4.1, 7.12, 10.4**
 *
 * Property 5 statement: for ANY set of loaded source tables and ANY approved
 * {@link StitchPlan} (arbitrary approved cleanings + matches), after
 * `StitchApplier.apply(plan, tables)` every ORIGINAL source table is byte-for-
 * byte unchanged — identical column schema (name + declared type via
 * `information_schema.columns`), identical row count, and identical, fully
 * ordered row contents it had before apply. The applier only ever issues DDL/
 * DML against freshly-created `stitch_`-prefixed tables and reads originals
 * read-only (design: "Table naming convention", Req 4.1), so originals are
 * provably untouched (Req 7.12, Req 10.4). This test also confirms the created
 * `stitch_<n>_*` tables are DISTINCT names from every original.
 *
 * This is the DuckDB-backed companion to the pure/unit applier tests: it proves
 * the invariant end-to-end against a real in-memory DuckDB engine, across
 * arbitrary small generated tables and arbitrary approved plans, rather than at
 * the SQL-string level.
 *
 * ## Environment note (same pattern as the other applier DuckDB tests)
 *
 * DuckDB-WASM's *browser* bundles need a real browser worker environment that
 * is unavailable under Vitest's jsdom runner, so this test wraps the
 * *node-blocking* MVP bundle (same engine over WebAssembly, synchronous API,
 * filesystem-located Wasm/worker assets) in a {@link DuckDBConnectionAdapter}
 * and injects it via {@link createDuckDBService}.
 *
 * ## Why ONE DuckDB instance for the whole file (test-stability note)
 *
 * The node-blocking MVP bundle is a single emscripten WebAssembly module. If it
 * is (re)instantiated and `reset()`-torn-down once per property iteration, its
 * emscripten runtime accumulates bad state, and the first time an apply SQL
 * raises a C++ exception the `invoke_*` trampolines call a now-undefined
 * `_setThrew` — surfacing intermittently as `ReferenceError: _setThrew is not
 * defined` only under the full suite. This is purely a test-harness/emscripten
 * artifact, not a production bug (the applier only ever touches `stitch_`-
 * prefixed copies). To avoid the instantiate/reset churn we create ONE in-
 * memory DuckDB for the whole file (`beforeAll`) and drop just the generated
 * tables between iterations, keeping the module resident and stable. Tables are
 * small (few columns, ≤ 6 rows) to keep each of the ≥ 100 iterations fast.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CellValue, ColumnSchema, ColumnType, LoadedTable } from "../types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { createStitchApplier, STITCH_TABLE_PREFIX } from "./stitch-applier";
import type {
  CleaningProposal,
  ColumnRef,
  MatchProposal,
  StitchPlan,
} from "./types";

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

/** A single in-memory node-blocking adapter + its disposer (one per FILE). */
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
// Generators — SMALL tables + arbitrary approved plans
// ---------------------------------------------------------------------------

const COLUMN_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/** A simple lowercase DuckDB identifier (keeps the focus on mutation, not quoting). */
const identArb = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.string({ minLength: 0, maxLength: 4 }).map((s) =>
      s.replace(/[^a-z0-9_]/gi, "").toLowerCase(),
    ),
  )
  .map(([head, tail]) => head + tail);

/** 1..3 uniquely-named columns with random types. */
const schemaArb: fc.Arbitrary<ColumnSchema[]> = fc
  .uniqueArray(identArb, { minLength: 1, maxLength: 3 })
  .chain((names) =>
    fc
      .tuple(...names.map(() => fc.constantFrom<ColumnType>(...COLUMN_TYPES)))
      .map((types) => names.map((name, i) => ({ name, type: types[i]! }))),
  );

/** NullToken strings the service stores as SQL NULL (still valid, still a row). */
const nullTokenArb = fc.constantFrom<CellValue>(null, "", "N/A", "null", "-");

/** A cell value that coerces cleanly for `type`, mixed with occasional nulls. */
function cellArb(type: ColumnType): fc.Arbitrary<CellValue> {
  const valid: fc.Arbitrary<CellValue> = (() => {
    switch (type) {
      case "number":
        return fc.integer({ min: -1000, max: 1000 }).map(String);
      case "boolean":
        return fc.constantFrom("true", "false");
      case "date":
        return fc.constantFrom("2026-01-05", "2024-12-31", "07/04/2020");
      case "string":
      default:
        // Include differing-casing / whitespace variants so cleaning plans have
        // something to act on, but never a NullToken (nulls come separately).
        return fc.constantFrom(
          "Swamp Wraith",
          "swamp wraith",
          "  Bog  Golem ",
          "Bog Golem",
          "Lone Ghoul",
          "alpha",
          "Alpha",
        );
    }
  })();
  return fc.oneof(
    { weight: 4, arbitrary: valid },
    { weight: 1, arbitrary: nullTokenArb },
  );
}

/** 0..6 rows of cells valid for `schema`. */
function rowsArb(schema: ColumnSchema[]): fc.Arbitrary<CellValue[][]> {
  const rowArb = fc.tuple(...schema.map((c) => cellArb(c.type)));
  return fc
    .array(rowArb, { minLength: 0, maxLength: 6 })
    .map((rows) => rows.map((r) => [...r]));
}

/** A single named source table: name + schema + rows. */
interface GenTable {
  name: string;
  schema: ColumnSchema[];
  rows: CellValue[][];
}

/** 2..3 source tables with distinct names, each with its own schema + rows. */
const tablesArb: fc.Arbitrary<GenTable[]> = fc
  .uniqueArray(identArb, { minLength: 2, maxLength: 3 })
  .chain((names) =>
    fc.tuple(
      ...names.map((name) =>
        schemaArb.chain((schema) =>
          rowsArb(schema).map((rows) => ({ name, schema, rows })),
        ),
      ),
    ),
  );

/**
 * Build an ARBITRARY approved plan over the generated tables: a random subset of
 * approved cleanings (whitespace-case, category-standardize, duplicate-rows,
 * number-column outliers) and approved cross-table matches. The plan need not be
 * "sensible" — any approved plan must still leave originals untouched (Req 4.1),
 * which is exactly what Property 5 asserts.
 */
function planArb(tables: GenTable[]): fc.Arbitrary<StitchPlan> {
  const stringCols = tables.flatMap((t) =>
    t.schema
      .filter((c) => c.type === "string")
      .map((c) => ({ table: t.name, column: c.name })),
  );
  // Only offer an outlier proposal for a number column that actually has at
  // least one non-null numeric value. The production rules engine never emits
  // an outlier proposal for an empty/all-null column (it requires outliers > 0,
  // see cleaning-rules.ts `buildOutlierProposal`), and `quantile_cont` over a
  // fully empty input crashes the DuckDB-WASM MVP bundle (same quirk class as
  // the NUL-byte / COUNT(DISTINCT) crashes the applier header documents). So we
  // constrain the generator to the realistic input space rather than exercising
  // a plan the engine would never produce.
  const nullTokenSet = new Set<string | null>([null, "", "N/A", "null", "-"]);
  const numberCols = tables.flatMap((t) => {
    const idxByCol = new Map(t.schema.map((c, i) => [c.name, i]));
    return t.schema
      .filter((c) => c.type === "number")
      .filter((c) => {
        const idx = idxByCol.get(c.name)!;
        return t.rows.some((row) => {
          const cell = row[idx];
          return !nullTokenSet.has(cell as string | null);
        });
      })
      .map((c) => ({ table: t.name, column: c.name }));
  });

  // Candidate cleaning proposals the generator can pick from.
  const cleaningCandidates: fc.Arbitrary<CleaningProposal>[] = [];
  for (const { table, column } of stringCols) {
    // whitespace-only.
    cleaningCandidates.push(
      fc.constant<CleaningProposal>({
        id: `ws:${table}.${column}`,
        target: { tableName: table, columnName: column },
        kind: "whitespace-case",
        before: "  Bog  Golem ",
        after: "Bog Golem",
        reason: "trim/collapse whitespace",
      }),
    );
    // case mapping (differing casings → canonical).
    cleaningCandidates.push(
      fc.constant<CleaningProposal>({
        id: `case:${table}.${column}`,
        target: { tableName: table, columnName: column },
        kind: "whitespace-case",
        before: "swamp wraith",
        after: "Swamp Wraith",
        reason: "standardize casing",
        variantMap: { "swamp wraith": "Swamp Wraith", alpha: "Alpha" },
      }),
    );
    // category-standardize (variants → canonical).
    cleaningCandidates.push(
      fc.constant<CleaningProposal>({
        id: `cat:${table}.${column}`,
        target: { tableName: table, columnName: column },
        kind: "category-standardize",
        before: "swamp wraith",
        after: "Swamp Wraith",
        reason: "standardize category",
        canonical: "Swamp Wraith",
        variantMap: { "swamp wraith": "Swamp Wraith", "Bog Golem": "Bog Golem" },
      }),
    );
  }
  for (const { table, column } of numberCols) {
    cleaningCandidates.push(
      fc.constant<CleaningProposal>({
        id: `out:${table}.${column}`,
        target: { tableName: table, columnName: column },
        kind: "outliers",
        before: 0,
        after: 0,
        reason: "flag outliers",
      }),
    );
  }
  // duplicate-rows (row-level, per table).
  for (const t of tables) {
    cleaningCandidates.push(
      fc.constant<CleaningProposal>({
        id: `dup:${t.name}`,
        target: { tableName: t.name },
        kind: "duplicate-rows",
        before: 0,
        after: 0,
        reason: "keep-first dedupe",
      }),
    );
  }

  const cleaningsArb =
    cleaningCandidates.length === 0
      ? fc.constant<CleaningProposal[]>([])
      : fc.subarray(cleaningCandidates).chain((picked) =>
          picked.length === 0
            ? fc.constant<CleaningProposal[]>([])
            : fc.tuple(...picked).map((arr) => [...arr]),
        );

  // Candidate matches: pair compatible columns across distinct tables.
  const ref = (table: string, column: string, type: ColumnType): ColumnRef => ({
    tableName: table,
    columnName: column,
    type,
  });
  const matchCandidates: MatchProposal[] = [];
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i]!;
      const b = tables[j]!;
      for (const ca of a.schema) {
        for (const cb of b.schema) {
          // Only pair same-typed columns so the generated join SQL is valid.
          if (ca.type !== cb.type) {
            continue;
          }
          matchCandidates.push({
            id: `m:${a.name}.${ca.name}=${b.name}.${cb.name}`,
            left: ref(a.name, ca.name, ca.type),
            right: ref(b.name, cb.name, cb.type),
            confidence: 0.9,
            reason: "generated match",
            source: "rules",
            components: { nameSim: 0.9, typeCompat: 1, valueOverlap: 0.9 },
          });
        }
      }
    }
  }
  // Pick at most one match per unordered table pair so the join chain stays a
  // simple tree (one key per pair) and the generated SQL is always valid.
  const matchesArb = fc.subarray(matchCandidates).map((picked) => {
    const usedPairs = new Set<string>();
    const chosen: MatchProposal[] = [];
    for (const m of picked) {
      const pairKey = [m.left.tableName, m.right.tableName].sort().join("|");
      if (usedPairs.has(pairKey)) {
        continue;
      }
      usedPairs.add(pairKey);
      chosen.push(m);
    }
    return chosen;
  });

  const anchorArb = fc.constantFrom(...tables.map((t) => t.name));

  return fc
    .tuple(cleaningsArb, matchesArb, anchorArb)
    .map(([approvedCleanings, approvedMatches, anchorTableName]) => ({
      anchorTableName,
      joinKeysByPair: {},
      approvedMatches,
      approvedCleanings,
    }));
}

/** A generated scenario: the source tables and an arbitrary approved plan. */
const scenarioArb = tablesArb.chain((tables) =>
  planArb(tables).map((plan) => ({ tables, plan })),
);

// ---------------------------------------------------------------------------
// Snapshotting helpers
// ---------------------------------------------------------------------------

/** The declared column schema (name + DuckDB data type) of a table. */
async function schemaSnapshot(
  service: ReturnType<typeof createDuckDBService>,
  tableName: string,
): Promise<string> {
  const rows = await service.query<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns " +
      `WHERE table_name = ${sqlLiteral(tableName)} ORDER BY ordinal_position`,
  );
  return JSON.stringify(
    rows.map((r) => [r.column_name, r.data_type]),
  );
}

/**
 * A fully-ordered, string-stable snapshot of every row of a table. All columns
 * are cast to VARCHAR so DATE epoch quirks and numeric formatting cannot cause
 * spurious diffs, and the whole table is ordered by every column so the
 * snapshot is deterministic regardless of physical row order.
 */
async function rowsSnapshot(
  service: ReturnType<typeof createDuckDBService>,
  tableName: string,
  schema: ColumnSchema[],
): Promise<string> {
  const casts = schema
    .map((c, i) => `CAST(${quoteIdent(c.name)} AS VARCHAR) AS ${quoteIdent(`c${i}`)}`)
    .join(", ");
  const order = schema.map((_, i) => `${quoteIdent(`c${i}`)} NULLS FIRST`).join(", ");
  const rows = await service.query<Record<string, unknown>>(
    `SELECT ${casts} FROM ${quoteIdent(tableName)} ORDER BY ${order}`,
  );
  return JSON.stringify(
    rows.map((r) =>
      schema.map((_, i) => {
        const v = r[`c${i}`];
        return v === null || v === undefined ? null : String(v);
      }),
    ),
  );
}

/** A full before/after snapshot of one original table. */
interface TableSnapshot {
  schema: string;
  rowCount: number;
  rows: string;
}

async function snapshotTable(
  service: ReturnType<typeof createDuckDBService>,
  table: GenTable,
): Promise<TableSnapshot> {
  return {
    schema: await schemaSnapshot(service, table.name),
    rowCount: await service.getRowCount(table.name),
    rows: await rowsSnapshot(service, table.name, table.schema),
  };
}

/** Double-quote an identifier (mirrors the Feature-1 quoteIdent). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quote a string literal (for information_schema lookups). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function loaded(table: GenTable, rowCount: number): LoadedTable {
  return {
    loadId: 0,
    tableName: table.name,
    sourceFileName: table.name,
    schema: table.schema,
    rowCount,
  };
}

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

/**
 * Drop every user table currently in the in-memory DuckDB so the next iteration
 * starts from a clean slate on the SAME resident instance (no module churn).
 * Uses the catalog to find table names and drops each with `DROP TABLE IF
 * EXISTS` (identifier-quoted), so generated originals and `stitch_`-prefixed
 * copies from the prior iteration never collide with the next one.
 */
async function dropAllTables(
  service: ReturnType<typeof createDuckDBService>,
): Promise<void> {
  const rows = await service.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'main'",
  );
  for (const { table_name } of rows) {
    await service.query(`DROP TABLE IF EXISTS ${quoteIdent(table_name)}`);
  }
}

describe("Property 5: Apply never mutates originals (DuckDB-backed)", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;
  let service: ReturnType<typeof createDuckDBService>;

  beforeAll(async () => {
    // ONE resident in-memory DuckDB for the whole file (see header note): this
    // avoids the per-iteration instantiate/reset churn that intermittently
    // wedges the emscripten MVP bundle (`_setThrew is not defined`).
    ({ adapter, dispose } = await createNodeAdapter());
    service = createDuckDBService(adapter);
    await service.init();
  });

  afterAll(() => {
    dispose?.();
  });

  it("leaves every original table's schema, row count, and contents byte-for-byte unchanged after apply", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ tables, plan }) => {
        // Clean slate on the resident instance before each iteration's tables.
        await dropAllTables(service);

        // Load the originals and snapshot them BEFORE apply.
        const loadedTables: LoadedTable[] = [];
        const before = new Map<string, TableSnapshot>();
        for (const t of tables) {
          const lt = await service.createTable(t.name, t.schema, t.rows);
          loadedTables.push(loaded(t, lt.rowCount));
          before.set(t.name, await snapshotTable(service, t));
        }

        // Apply the arbitrary approved plan.
        const applier = createStitchApplier(service);
        const result = await applier.apply(plan, loadedTables);

        // (a) Every created table is stitch_-prefixed and DISTINCT from every
        //     original name — the applier never reused/overwrote an original.
        const originalNames = new Set(tables.map((t) => t.name));
        for (const created of result.undoStep.createdTableNames) {
          expect(created.startsWith(STITCH_TABLE_PREFIX)).toBe(true);
          expect(originalNames.has(created)).toBe(false);
        }

        // (b) Every original is byte-for-byte unchanged (schema + count + rows).
        for (const t of tables) {
          const after = await snapshotTable(service, t);
          const prior = before.get(t.name)!;
          expect(after.schema).toBe(prior.schema);
          expect(after.rowCount).toBe(prior.rowCount);
          expect(after.rows).toBe(prior.rows);
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
