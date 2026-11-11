/**
 * Property 6 — Undo restores pre-apply state (DuckDB-backed).
 *
 * Feature: frankendata-ai-stitching, Design Property 6 ("Undo restores
 * pre-apply state", design: "Correctness Properties" → Property 6; design
 * "Apply and Undo in DuckDB" → "Undo").
 *
 * **Validates: Requirements 4.3, 10.5**
 *
 * Property 6 statement (design): *for any* applied {@link StitchPlan}, `undo()`
 * drops EXACTLY the tables the apply created and restores the set of tables
 * present immediately before apply. This is Req 4.3 ("restore the application
 * to the state immediately before the StitchPlan was applied, including
 * removing any tables or views the apply created") and the required property
 * test Req 10.5.
 *
 * What this test proves, end-to-end against a real in-memory DuckDB engine,
 * across arbitrary small generated tables and arbitrary approved plans:
 *
 *   1. apply → undo leaves the FULL SET of table NAMES (read from
 *      `information_schema.tables`) identical to the set present immediately
 *      before apply — no leftover `stitch_<n>_*` table remains after undo;
 *   2. every ORIGINAL table's contents (fully-ordered rows) and schema are the
 *      same after apply→undo as before apply (undo removes only what apply
 *      added and touches nothing else);
 *   3. apply actually DID create at least one `stitch_`-prefixed table (so the
 *      undo under test is exercising real teardown, not a no-op), and
 *   4. `undo()` returns EXACTLY `applyResult.undoStep.createdTableNames` — the
 *      recorded created names — i.e. it drops precisely those tables (Req 4.3:
 *      "removing any tables or views the apply created").
 *
 * ## Environment note (same pattern as the Property-5 no-mutation test)
 *
 * DuckDB-WASM's *browser* bundles need a real browser worker environment that
 * is unavailable under Vitest's jsdom runner, so this test wraps the
 * *node-blocking* MVP bundle (same engine over WebAssembly, synchronous API,
 * filesystem-located Wasm/worker assets) in a {@link DuckDBConnectionAdapter}
 * and injects it via {@link createDuckDBService}. A FRESH in-memory DuckDB is
 * created per property iteration and disposed after it, so the MVP bundle never
 * carries a bad `_setThrew` state between iterations (observed when an apply SQL
 * throws mid-run and the same instance is reused). Tables are small (few
 * columns, ≤ 6 rows) to keep each DuckDB-backed iteration fast while still
 * running ≥ 100 iterations.
 *
 * The smart generator is shared with the Property-5 companion
 * (`stitch-applier.no-mutation.property.test.ts`): plans stay within the real
 * engine's input space — e.g. outlier cleaning is only offered for number
 * columns that actually have a non-null numeric value (the production rules
 * engine never emits an outlier proposal for an empty/all-null column, and
 * `quantile_cont` over a fully empty input crashes the MVP bundle), and at most
 * one match per unordered table pair so the join chain stays a simple tree.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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

/** A FRESH in-memory node-blocking adapter + its disposer (one per iteration). */
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
// Generators — SMALL tables + arbitrary approved plans (shared with Property 5)
// ---------------------------------------------------------------------------

const COLUMN_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/** A simple lowercase DuckDB identifier (keeps the focus on undo, not quoting). */
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
 * "sensible" — undo must still exactly reverse whatever apply created, which is
 * what Property 6 asserts.
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
  // fully empty input crashes the DuckDB-WASM MVP bundle. So we constrain the
  // generator to the realistic input space rather than exercising a plan the
  // engine would never produce.
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

/**
 * The sorted set of ALL table names currently in the database (the "state"
 * whose restoration Property 6 asserts). Read from `information_schema.tables`
 * so cleaned copies / the joined result (`stitch_<n>_*`) are included between
 * apply and undo and their absence after undo is detectable.
 */
async function tableNameSet(
  service: ReturnType<typeof createDuckDBService>,
): Promise<string[]> {
  const rows = await service.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'main' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name).sort();
}

/** The declared column schema (name + DuckDB data type) of a table. */
async function schemaSnapshot(
  service: ReturnType<typeof createDuckDBService>,
  tableName: string,
): Promise<string> {
  const rows = await service.query<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns " +
      `WHERE table_name = ${sqlLiteral(tableName)} ORDER BY ordinal_position`,
  );
  return JSON.stringify(rows.map((r) => [r.column_name, r.data_type]));
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

/** A full snapshot of one original table (schema + row count + ordered rows). */
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
// Property 6
// ---------------------------------------------------------------------------

describe("Property 6: Undo restores pre-apply state (DuckDB-backed)", () => {
  it("drops exactly the created tables and restores the full pre-apply table set and contents", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ tables, plan }) => {
        // FRESH in-memory DuckDB per iteration (avoids MVP bad-state carry-over).
        const { adapter, dispose } = await createNodeAdapter();
        try {
          const service = createDuckDBService(adapter);
          await service.init();

          // Load the originals, then snapshot the FULL pre-apply state: the set
          // of table names present and each original's schema + rows.
          const loadedTables: LoadedTable[] = [];
          const beforeContents = new Map<string, TableSnapshot>();
          for (const t of tables) {
            const lt = await service.createTable(t.name, t.schema, t.rows);
            loadedTables.push(loaded(t, lt.rowCount));
          }
          for (const t of tables) {
            beforeContents.set(t.name, await snapshotTable(service, t));
          }
          const beforeTableSet = await tableNameSet(service);

          // Apply the arbitrary approved plan.
          const applier = createStitchApplier(service);
          const result = await applier.apply(plan, loadedTables);

          // Precondition sanity: apply created at least one stitch_ table (so
          // this undo exercises real teardown, not a vacuous no-op). Every
          // created name carries the stitch_ prefix.
          const createdNames = result.undoStep.createdTableNames;
          expect(createdNames.length).toBeGreaterThan(0);
          for (const created of createdNames) {
            expect(created.startsWith(STITCH_TABLE_PREFIX)).toBe(true);
          }

          // After apply, the table set grew by exactly the created tables.
          const afterApplyTableSet = await tableNameSet(service);
          expect(afterApplyTableSet).toEqual(
            [...beforeTableSet, ...createdNames].sort(),
          );

          // Undo.
          const dropped = await applier.undo();

          // (a) undo dropped EXACTLY the recorded created tables (Req 4.3:
          //     "removing any tables or views the apply created").
          expect([...dropped].sort()).toEqual([...createdNames].sort());

          // (b) the FULL set of table names is byte-for-byte the pre-apply set:
          //     no leftover stitch_<n>_* table remains, nothing extra dropped.
          const afterUndoTableSet = await tableNameSet(service);
          expect(afterUndoTableSet).toEqual(beforeTableSet);
          for (const name of afterUndoTableSet) {
            expect(name.startsWith(STITCH_TABLE_PREFIX)).toBe(false);
          }

          // (c) every original table's schema + row count + ordered contents are
          //     identical to their pre-apply snapshot (undo restored the state).
          for (const t of tables) {
            const after = await snapshotTable(service, t);
            const prior = beforeContents.get(t.name)!;
            expect(after.schema).toBe(prior.schema);
            expect(after.rowCount).toBe(prior.rowCount);
            expect(after.rows).toBe(prior.rows);
          }
        } finally {
          dispose();
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
