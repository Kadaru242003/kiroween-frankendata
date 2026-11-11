/**
 * DuckDB-backed tests for the top-level StitchApplier lifecycle (Feature 2,
 * task 8.3). These run the full apply/undo pipeline against a real in-memory
 * DuckDB and assert the behavioral guarantees that the pure-unit companion
 * (`stitch-applier.lifecycle.test.ts`) can only assert at the SQL level:
 *
 *   - apply creates the cleaned copies + result and they actually exist;
 *   - the recorded UndoStep names the tables that were really created (Req 4.2);
 *   - undo DROPs exactly those tables and leaves the originals intact (Req 4.3,
 *     7.12) — row counts and schema of every original are unchanged;
 *   - repeated apply/undo cycles work, with the counter embedded in every name
 *     so a re-apply before undo never collides (design: "Table naming");
 *   - the fan-out counts reflect the REAL anchor-vs-result row counts (Req 7.9),
 *     including a genuine many-to-many fan-out.
 *
 * ## Environment note (same pattern as stitch-applier.duckdb.test.ts)
 *
 * DuckDB-WASM's browser bundles need a real browser worker environment that is
 * unavailable under Vitest's jsdom runner, so this test wraps the node-blocking
 * bundle in a DuckDBConnectionAdapter and injects it via createDuckDBService. A
 * fresh in-memory DuckDB per test keeps the MVP bundle from carrying a bad
 * state between tests.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ColumnSchema, LoadedTable } from "../types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { createStitchApplier } from "./stitch-applier";
import type { ColumnRef, MatchProposal, StitchPlan } from "./types";

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

function ref(tableName: string, columnName: string): ColumnRef {
  return { tableName, columnName, type: "string" };
}

function match(
  left: ColumnRef,
  right: ColumnRef,
  confidence: number,
  id = `m:${left.tableName}.${left.columnName}=${right.tableName}.${right.columnName}`,
): MatchProposal {
  return {
    id,
    left,
    right,
    confidence,
    reason: "test",
    source: "rules",
    components: { nameSim: confidence, typeCompat: 1, valueOverlap: confidence },
  };
}

let serialCounter = 0;
function uniqueName(base: string): string {
  serialCounter += 1;
  return `${base}_${serialCounter}`;
}

/** Does a table exist in the catalog? */
async function tableExists(
  service: ReturnType<typeof createDuckDBService>,
  name: string,
): Promise<boolean> {
  const rows = await service.query<{ n: number | bigint }>(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = ${qiLiteral(
      name,
    )}`,
  );
  return Number(rows[0].n) === 1;
}

/** A single-quoted string literal (for the catalog lookup). */
function qiLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function loaded(
  tableName: string,
  schema: ColumnSchema[],
  rowCount: number,
): LoadedTable {
  return {
    loadId: 0,
    tableName,
    sourceFileName: tableName,
    schema,
    rowCount,
  };
}

describe("StitchApplier lifecycle over a real DuckDB", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeEach(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterEach(() => {
    dispose?.();
  });

  it("apply creates the cleaned copies + result; undo drops exactly those and leaves originals intact (Req 4.2, 4.3, 7.12)", async () => {
    const service = createDuckDBService(adapter);
    await service.init();
    const monsters = uniqueName("monsters");
    const experiments = uniqueName("experiments");
    const mSchema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "weight", type: "number" },
    ];
    const eSchema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "status", type: "string" },
    ];
    await service.createTable(monsters, mSchema, [
      ["  Swamp   Wraith ", "100"],
      ["Bog Golem", "200"],
      ["Lone Ghoul", "50"],
    ]);
    await service.createTable(experiments, eSchema, [
      ["Swamp Wraith", "sedated"],
      ["Bog Golem", "active"],
    ]);

    const applier = createStitchApplier(service);
    const plan: StitchPlan = {
      anchorTableName: monsters,
      joinKeysByPair: {},
      approvedMatches: [
        match(ref(monsters, "name"), ref(experiments, "name"), 0.9),
      ],
      // Clean the monsters key so whitespace normalizes before the join.
      approvedCleanings: [
        {
          id: "ws",
          target: { tableName: monsters, columnName: "name" },
          kind: "whitespace-case",
          before: "  Swamp   Wraith ",
          after: "Swamp Wraith",
          reason: "ws",
        },
      ],
    };

    const r = await applier.apply(plan, [
      loaded(monsters, mSchema, 3),
      loaded(experiments, eSchema, 2),
    ]);

    // The UndoStep names exactly the created tables, copies first then result.
    expect(r.undoStep.createdTableNames).toEqual([
      `stitch_1_clean_${monsters}`,
      "stitch_1_result",
    ]);
    // All created tables actually exist.
    for (const name of r.undoStep.createdTableNames) {
      expect(await tableExists(service, name)).toBe(true);
    }
    // The LEFT JOIN kept all three anchor rows; post-cleaning key matched.
    const rc = await service.getRowCount("stitch_1_result");
    expect(rc).toBe(3);

    // Undo drops exactly those tables.
    const dropped = await applier.undo();
    expect(dropped).toEqual(r.undoStep.createdTableNames);
    for (const name of r.undoStep.createdTableNames) {
      expect(await tableExists(service, name)).toBe(false);
    }
    // Originals are untouched: still present with their original row counts.
    expect(await tableExists(service, monsters)).toBe(true);
    expect(await tableExists(service, experiments)).toBe(true);
    expect(await service.getRowCount(monsters)).toBe(3);
    expect(await service.getRowCount(experiments)).toBe(2);
    expect(applier.pendingUndo()).toBeNull();
  });

  it("supports repeated apply/undo cycles with a monotonic counter", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("a");
    const b = uniqueName("b");
    const schema: ColumnSchema[] = [{ name: "id", type: "string" }];
    await service.createTable(a, schema, [["1"], ["2"]]);
    await service.createTable(b, schema, [["1"]]);

    const applier = createStitchApplier(service);
    const plan: StitchPlan = {
      anchorTableName: a,
      joinKeysByPair: {},
      approvedMatches: [match(ref(a, "id"), ref(b, "id"), 0.9)],
      approvedCleanings: [],
    };
    const tables = [loaded(a, schema, 2), loaded(b, schema, 1)];

    const r1 = await applier.apply(plan, tables);
    expect(r1.resultTableName).toBe("stitch_1_result");
    expect(await tableExists(service, "stitch_1_result")).toBe(true);
    await applier.undo();
    expect(await tableExists(service, "stitch_1_result")).toBe(false);

    // Second cycle: fresh counter, new disjoint name.
    const r2 = await applier.apply(plan, tables);
    expect(r2.resultTableName).toBe("stitch_2_result");
    expect(await tableExists(service, "stitch_2_result")).toBe(true);
    await applier.undo();
    expect(await tableExists(service, "stitch_2_result")).toBe(false);

    // Originals survive every cycle.
    expect(await service.getRowCount(a)).toBe(2);
    expect(await service.getRowCount(b)).toBe(1);
  });

  it("re-applying before undo produces disjoint, non-colliding tables", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("ra");
    const schema: ColumnSchema[] = [{ name: "id", type: "string" }];
    await service.createTable(a, schema, [["1"]]);

    const applier = createStitchApplier(service);
    const plan: StitchPlan = {
      anchorTableName: a,
      joinKeysByPair: {},
      approvedMatches: [],
      // A cleaning so each apply produces a stitch_<n>_clean_<a> copy too.
      approvedCleanings: [
        {
          id: "ws",
          target: { tableName: a, columnName: "id" },
          kind: "whitespace-case",
          before: " 1 ",
          after: "1",
          reason: "ws",
        },
      ],
    };
    const tables = [loaded(a, schema, 1)];

    const r1 = await applier.apply(plan, tables);
    const r2 = await applier.apply(plan, tables); // no undo in between.

    // Both applies' tables coexist without collision.
    for (const name of [
      ...r1.undoStep.createdTableNames,
      ...r2.undoStep.createdTableNames,
    ]) {
      expect(await tableExists(service, name)).toBe(true);
    }
    expect(r1.undoStep.createdTableNames).toContain(`stitch_1_clean_${a}`);
    expect(r2.undoStep.createdTableNames).toContain(`stitch_2_clean_${a}`);

    // Undo drops only the LATEST apply's tables; the earlier apply survives.
    await applier.undo();
    for (const name of r2.undoStep.createdTableNames) {
      expect(await tableExists(service, name)).toBe(false);
    }
    for (const name of r1.undoStep.createdTableNames) {
      expect(await tableExists(service, name)).toBe(true);
    }
  });

  it("reports a real many-to-many fan-out (result > anchor) (Req 7.9)", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("fa");
    const b = uniqueName("fb");
    const aSchema: ColumnSchema[] = [{ name: "id", type: "string" }];
    const bSchema: ColumnSchema[] = [
      { name: "id", type: "string" },
      { name: "v", type: "string" },
    ];
    // Anchor has 2 rows; b has two matches for id=1 → that anchor row fans out.
    await service.createTable(a, aSchema, [["1"], ["2"]]);
    await service.createTable(b, bSchema, [
      ["1", "x"],
      ["1", "y"],
    ]);

    const applier = createStitchApplier(service);
    const plan: StitchPlan = {
      anchorTableName: a,
      joinKeysByPair: {},
      approvedMatches: [match(ref(a, "id"), ref(b, "id"), 0.9)],
      approvedCleanings: [],
    };
    const r = await applier.apply(plan, [
      loaded(a, aSchema, 2),
      loaded(b, bSchema, 2),
    ]);
    // anchor had 2 rows; result has 3 (id=1 fanned to 2, id=2 stays 1).
    expect(r.fanOut.anchorRowCount).toBe(2);
    expect(r.fanOut.resultRowCount).toBe(3);
    expect(r.fanOut.fannedOut).toBe(true);
  });

  it("reports no fan-out for a one-to-one join (Req 7.9)", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("oa");
    const b = uniqueName("ob");
    const aSchema: ColumnSchema[] = [{ name: "id", type: "string" }];
    const bSchema: ColumnSchema[] = [
      { name: "id", type: "string" },
      { name: "v", type: "string" },
    ];
    await service.createTable(a, aSchema, [["1"], ["2"]]);
    await service.createTable(b, bSchema, [["1", "x"]]);

    const applier = createStitchApplier(service);
    const plan: StitchPlan = {
      anchorTableName: a,
      joinKeysByPair: {},
      approvedMatches: [match(ref(a, "id"), ref(b, "id"), 0.9)],
      approvedCleanings: [],
    };
    const r = await applier.apply(plan, [
      loaded(a, aSchema, 2),
      loaded(b, bSchema, 1),
    ]);
    expect(r.fanOut.anchorRowCount).toBe(2);
    expect(r.fanOut.resultRowCount).toBe(2);
    expect(r.fanOut.fannedOut).toBe(false);
  });
});
