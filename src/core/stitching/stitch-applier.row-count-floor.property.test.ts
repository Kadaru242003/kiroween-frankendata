/**
 * Property 8 — LEFT JOIN row-count floor (DuckDB-backed).
 *
 * Feature: frankendata-ai-stitching, Design Property 8 ("LEFT JOIN row-count
 * floor", design: "Correctness Properties" → Property 8; design "Apply" →
 * "Join chain").
 *
 * **Validates: Requirements 7.1, 10.8**
 *
 * Property 8 statement (design): *for any* {@link StitchPlan}, the
 * `StitchedTable` produced by the LEFT JOIN chain never has fewer rows than its
 * anchor table. A LEFT JOIN preserves every left (anchor) row whether or not it
 * finds a match on the right, so the materialized `stitch_<n>_result` always
 * has AT LEAST as many rows as the anchor — fan-out (many-to-many) can only
 * ADD rows, never drop anchor rows (Req 7.1, required property Req 10.8).
 *
 * What this test proves, end-to-end against a real in-memory DuckDB engine,
 * across arbitrary small generated tables and arbitrary approved plans:
 *
 *   1. apply runs the production join chain in
 *      {@link createStitchApplier}/`applyJoinChain` and materializes a real
 *      `stitch_<n>_result` table;
 *   2. the anchor is determined THE SAME WAY the applier does — the first
 *      logical table in the returned `joinOrder`, which `applyJoinChain`
 *      derives via `selectAnchorTable` (most rows by default, honoring the
 *      plan's `anchorTableName` override when set);
 *   3. the result's row count, read back from DuckDB, is `>=` the row count of
 *      the table that actually feeds the LEFT JOIN as its left (anchor) input
 *      — the anchor's *cleaned copy* (`stitch_<n>_clean_<anchor>`) when apply
 *      created one for the anchor (Req 7.8: keys compare post-cleaning), else
 *      the original anchor table. Both counts are read back from DuckDB, not
 *      trusted as pre-computed numbers. This floor holds including when the
 *      result fans out (many-to-many only ADDS rows); and
 *   4. the applier's own reported `fanOut` result count agrees with the
 *      independently re-read DuckDB count and is itself never below the
 *      reported anchor count, with `fannedOut` set iff the result strictly
 *      exceeds it.
 *
 * ## Why the floor's base is the cleaned anchor, not the original
 *
 * A LEFT JOIN preserves every row of its LEFT input. In the apply pipeline the
 * anchor's left input is its *cleaned copy* whenever the plan approved cleaning
 * for the anchor, and cleaning can change the anchor's row count BEFORE the
 * join even starts — a `duplicate-rows` dedupe removes rows. So the LEFT JOIN
 * floor is relative to that cleaned input, not the pre-cleaning original
 * `LoadedTable.rowCount` (which the applier reports as `fanOut.anchorRowCount`
 * purely as a UI warning heuristic). Comparing the result against the original
 * would spuriously "fail" whenever an approved dedupe shrank the anchor — which
 * is not a join dropping rows. This test therefore compares against the real
 * left-side input the join reads.
 *
 * Both the DEFAULT anchor (most rows) and the OVERRIDE path (plan supplies an
 * explicit `anchorTableName`) are exercised: the generator sometimes leaves the
 * override unset and sometimes pins it to one of the generated tables.
 *
 * ## Environment note (same pattern as the Property 5/6 DuckDB-backed tests)
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
 * The smart generator mirrors the Property-5/6 companions
 * (`stitch-applier.no-mutation.property.test.ts`,
 * `stitch-applier.undo.property.test.ts`): plans stay within the real engine's
 * input space — at most one match per unordered table pair so the join chain
 * stays a simple tree, and cross-table matches only pair same-typed columns so
 * the generated join SQL is valid. It deliberately covers the cleanings that
 * can MOVE row counts (text whitespace/case/category normalization, and
 * `duplicate-rows` dedupe, which shrinks the anchor before the join) but omits
 * `outliers` cleaning: it only appends an `is_outlier` column, never changes
 * row counts, and its `quantile_cont` SQL is a known source of MVP-bundle
 * flakiness. The outlier SQL is covered by the cleaning/no-mutation/undo DuckDB
 * tests instead.
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
import { cleanedCopyTableName, createStitchApplier } from "./stitch-applier";
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
// Generators — SMALL tables + arbitrary approved plans (shared design with the
// Property 5/6 companions).
// ---------------------------------------------------------------------------

const COLUMN_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/** A simple lowercase DuckDB identifier (keeps the focus on the floor). */
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

/** NullToken strings the service stores as SQL NULL (still a row). */
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
        // A SMALL value pool with differing-casing / whitespace variants: it
        // gives cleaning plans something to act on and — crucially for Property
        // 8 — makes key collisions common, so many-to-many fan-out (the
        // interesting floor case, where rows grow past the anchor) actually
        // happens across iterations.
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
 * Build an ARBITRARY approved plan over the generated tables: a random subset
 * of approved cleanings (whitespace-case, category-standardize, duplicate-rows,
 * number-column outliers) and approved cross-table matches, plus an OPTIONAL
 * anchor override. The floor must hold whatever the plan is — the default
 * anchor (most rows) and an explicit override are both exercised.
 */
function planArb(tables: GenTable[]): fc.Arbitrary<StitchPlan> {
  const stringCols = tables.flatMap((t) =>
    t.schema
      .filter((c) => c.type === "string")
      .map((c) => ({ table: t.name, column: c.name })),
  );
  // NOTE — outlier cleanings are intentionally NOT generated here. An approved
  // outlier proposal only APPENDS an `is_outlier` boolean column; it never
  // changes a table's row count, so it is irrelevant to the LEFT JOIN row-count
  // floor this property asserts. Including it would only add flakiness: the
  // apply step's `quantile_cont` Tukey-fence SQL intermittently corrupts the
  // DuckDB-WASM MVP bundle's internal state ("_setThrew is not defined") under
  // the full-suite environment even on well-formed numeric columns. The outlier
  // SQL's behavior is covered by the dedicated cleaning/no-mutation/undo DuckDB
  // tests; this test stays focused on what moves row counts — anchor selection,
  // matches/fan-out, text cleanings, and dedupe (which shrinks the anchor).

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

  // Candidate matches: pair same-typed columns across distinct tables so the
  // generated join SQL is valid.
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
  // At most one match per unordered table pair so the join chain stays a simple
  // tree (one key per pair) and the generated SQL is always valid.
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

  // Anchor override (`StitchPlan.anchorTableName`): either a name that matches
  // NO generated table (an empty sentinel) so the applier falls back to the
  // DEFAULT anchor = most rows (Req 7.2, see `selectAnchorTable` — an override
  // that names no table is ignored), or one of the generated tables (the UI's
  // "change anchor" path). Both must uphold the floor.
  const anchorArb = fc.oneof(
    fc.constant<string>(""),
    fc.constantFrom(...tables.map((t) => t.name)),
  );

  return fc
    .tuple(cleaningsArb, matchesArb, anchorArb)
    .map(([approvedCleanings, approvedMatches, anchorTableName]) => {
      const plan: StitchPlan = {
        anchorTableName,
        joinKeysByPair: {},
        approvedMatches,
        approvedCleanings,
      };
      return plan;
    });
}

/** A generated scenario: the source tables and an arbitrary approved plan. */
const scenarioArb = tablesArb.chain((tables) =>
  planArb(tables).map((plan) => ({ tables, plan })),
);

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
// Property 8
// ---------------------------------------------------------------------------

describe("Property 8: LEFT JOIN row-count floor (DuckDB-backed)", () => {
  it("the stitched result never has fewer rows than its anchor table", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ tables, plan }) => {
        // FRESH in-memory DuckDB per iteration (avoids MVP bad-state carry-over).
        const { adapter, dispose } = await createNodeAdapter();
        try {
          const service = createDuckDBService(adapter);
          await service.init();

          // Load the originals; carry each table's actual stored row count into
          // the LoadedTable the applier reads for anchor selection.
          const loadedTables: LoadedTable[] = [];
          for (const t of tables) {
            const lt = await service.createTable(t.name, t.schema, t.rows);
            loadedTables.push(loaded(t, lt.rowCount));
          }

          // Apply the arbitrary approved plan through the production join chain.
          const applier = createStitchApplier(service);
          const result = await applier.apply(plan, loadedTables);

          // Determine the anchor THE SAME WAY the applier does: the first
          // logical table in joinOrder (derived via selectAnchorTable — most
          // rows by default, honoring plan.anchorTableName when set).
          const anchorTableName = result.joinOrder[0]!;

          // The LEFT JOIN floor is a statement about the cardinality of the
          // table that actually feeds the join as its LEFT side. The apply
          // pipeline reads each table from its *cleaned copy* when it had
          // approved cleaning (so keys compare post-cleaning, Req 7.8), and
          // cleaning can legitimately CHANGE the anchor's row count before the
          // join even starts — a `duplicate-rows` dedupe removes rows. The
          // floor the LEFT JOIN guarantees is relative to THAT physical input,
          // not the pre-cleaning original. So the comparison base is the
          // anchor's cleaned copy (`stitch_<n>_clean_<anchor>`) when apply
          // created one for the anchor, else the original anchor table.
          const anchorCleanName = cleanedCopyTableName(
            result.counter,
            anchorTableName,
          );
          const anchorReadTableName = result.undoStep.createdTableNames.includes(
            anchorCleanName,
          )
            ? anchorCleanName
            : anchorTableName;

          // Read BOTH counts back from DuckDB (not from pre-computed numbers):
          // the anchor LEFT-side input's row count and the materialized
          // result's.
          const anchorInputRowCount =
            await service.getRowCount(anchorReadTableName);
          const resultRowCount = await service.getRowCount(
            result.resultTableName,
          );

          // The floor: a LEFT JOIN never drops rows from its left (anchor)
          // input, so the result has at least as many rows as that input —
          // many-to-many fan-out only ADDS rows (Req 7.1, Req 10.8).
          expect(resultRowCount).toBeGreaterThanOrEqual(anchorInputRowCount);

          // Cross-check the applier's own fan-out report where it is a real
          // invariant: its reported result count matches the independently
          // re-read DuckDB count, and `fannedOut` is set iff the reported
          // result strictly exceeds the reported anchor count (Req 7.9 — the
          // UI warning derivation).
          //
          // NOTE: we do NOT assert `resultRowCount >= anchorRowCount` on the
          // applier's own fan-out numbers. Its `anchorRowCount` is the
          // PRE-CLEANING original `LoadedTable.rowCount` (a UI warning
          // heuristic), so when an approved `duplicate-rows` dedupe shrinks the
          // anchor the reported result can legitimately sit below it. That is
          // not the LEFT JOIN dropping rows — the real join floor, asserted
          // above against the cleaned left-side input, is what Property 8
          // (Req 7.1, 10.8) guarantees.
          expect(result.fanOut.resultRowCount).toBe(resultRowCount);
          expect(result.fanOut.fannedOut).toBe(
            result.fanOut.resultRowCount > result.fanOut.anchorRowCount,
          );
          if (anchorReadTableName === anchorTableName) {
            // No cleaning changed the anchor input: the applier's reported
            // anchor count equals the real left-side input count, so the floor
            // holds against the applier's reported numbers too.
            expect(result.fanOut.anchorRowCount).toBe(anchorInputRowCount);
            expect(result.fanOut.resultRowCount).toBeGreaterThanOrEqual(
              result.fanOut.anchorRowCount,
            );
          }
        } finally {
          dispose();
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
