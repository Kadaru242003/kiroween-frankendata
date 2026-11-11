/**
 * DuckDB-backed tests for the StitchApplier join chain (Feature 2, task 8.2).
 * These run the generated `CREATE TABLE stitch_<n>_result AS SELECT …` against
 * a real in-memory DuckDB and assert the behavioral guarantees:
 *
 *   - the LEFT JOIN never drops anchor rows (row-count floor, Req 7.1);
 *   - tables are joined in descending approved-match confidence (Req 7.3);
 *   - keys are compared AFTER cleaning (the join reads the cleaned copies, so a
 *     whitespace/case difference in the raw data still matches, Req 7.8);
 *   - the key column appears once under the anchor name (Req 7.6);
 *   - a colliding non-key column is prefixed with its source table (Req 7.10);
 *   - non-key approved matches ride along as same-meaning columns (Req 7.5);
 *   - originals are never mutated (Req 7.12);
 *   - adversarial names land as identifiers, not SQL (Property 13).
 *
 * ## Environment note (same pattern as stitch-applier.duckdb.test.ts)
 *
 * DuckDB-WASM's browser bundles need a real browser worker environment that is
 * unavailable under Vitest's jsdom runner, so this test wraps the node-blocking
 * bundle in a DuckDBConnectionAdapter and injects it via createDuckDBService.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ColumnSchema } from "../types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import {
  applyCleanedCopy,
  applyJoinChain,
  type JoinTableInput,
} from "./stitch-applier";
import type { ColumnRef, MatchProposal } from "./types";

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

function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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

describe("StitchApplier join chain over a real DuckDB", () => {
  // A fresh in-memory DuckDB per test: the MVP node-blocking bundle can be left
  // in a bad state ("_setThrew is not defined") by certain join/DDL shapes, so
  // isolating each test behind its own instance keeps them independent.
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeEach(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterEach(() => {
    dispose?.();
  });

  it("LEFT JOIN never drops anchor rows and folds the key once (Req 7.1, 7.6)", async () => {
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
      ["Swamp Wraith", "100"],
      ["Bog Golem", "200"],
      ["Lone Ghoul", "50"], // no matching experiment → LEFT JOIN keeps it.
    ]);
    await service.createTable(experiments, eSchema, [
      ["Swamp Wraith", "sedated"],
      ["Bog Golem", "active"],
    ]);

    const anchor: JoinTableInput = {
      tableName: monsters,
      readTableName: monsters,
      rowCount: 3,
      schema: mSchema,
    };
    const joined: JoinTableInput = {
      tableName: experiments,
      readTableName: experiments,
      rowCount: 2,
      schema: eSchema,
    };
    const key = match(ref(monsters, "name"), ref(experiments, "name"), 0.9);

    const { tableName, columns } = await applyJoinChain(
      service,
      0,
      [anchor, joined],
      [key],
    );

    // Row-count floor: result has at least the anchor's rows (Req 7.1).
    const rc = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM ${qi(tableName)}`,
    );
    expect(Number(rc[0].n)).toBeGreaterThanOrEqual(3);

    // Key column appears ONCE, under the anchor's name (Req 7.6).
    const names = columns.map((c) => c.name);
    expect(names).toEqual(["name", "weight", "status"]);

    // The unmatched anchor row survives with NULL status.
    const lone = await service.query<{ status: string | null }>(
      `SELECT status FROM ${qi(tableName)} WHERE name = 'Lone Ghoul'`,
    );
    expect(lone).toHaveLength(1);
    expect(lone[0].status).toBeNull();
  });

  it("compares keys AFTER cleaning (reads the cleaned copies, Req 7.8)", async () => {
    const service = createDuckDBService(adapter);
    const monsters = uniqueName("mon");
    const experiments = uniqueName("exp");
    const keySchema: ColumnSchema[] = [{ name: "name", type: "string" }];
    const eSchema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "status", type: "string" },
    ];
    // Raw keys differ only by whitespace/case; cleaning normalizes them.
    await service.createTable(monsters, keySchema, [["  Swamp   Wraith "]]);
    await service.createTable(experiments, eSchema, [
      ["swamp wraith", "sedated"],
    ]);

    // Clean both key columns (whitespace collapse on monsters, case map on exp).
    const monClean = await applyCleanedCopy(service, 0, monsters, keySchema, {
      columnProposals: [
        {
          id: "ws",
          target: { tableName: monsters, columnName: "name" },
          kind: "whitespace-case",
          before: "  Swamp   Wraith ",
          after: "Swamp Wraith",
          reason: "ws",
        },
      ],
      outlierColumns: [],
      dedupe: false,
    });
    const expClean = await applyCleanedCopy(service, 0, experiments, eSchema, {
      columnProposals: [
        {
          id: "cat",
          target: { tableName: experiments, columnName: "name" },
          kind: "category-standardize",
          before: "swamp wraith",
          after: "Swamp Wraith",
          reason: "cat",
          canonical: "Swamp Wraith",
          variantMap: { "swamp wraith": "Swamp Wraith" },
        },
      ],
      outlierColumns: [],
      dedupe: false,
    });

    const anchor: JoinTableInput = {
      tableName: monsters,
      readTableName: monClean,
      rowCount: 1,
      schema: keySchema,
    };
    const joined: JoinTableInput = {
      tableName: experiments,
      readTableName: expClean,
      rowCount: 1,
      schema: eSchema,
    };
    const key = match(ref(monsters, "name"), ref(experiments, "name"), 0.9);

    const { tableName } = await applyJoinChain(
      service,
      0,
      [anchor, joined],
      [key],
    );
    // Despite differing raw spellings, the post-cleaning keys match → status set.
    const rows = await service.query<{ name: string; status: string | null }>(
      `SELECT name, status FROM ${qi(tableName)}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Swamp Wraith");
    expect(rows[0].status).toBe("sedated");
  });

  it("joins three tables in descending confidence and carries same-meaning columns (Req 7.3, 7.5)", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("a");
    const b = uniqueName("b");
    const c = uniqueName("c");
    const aSchema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "alt", type: "string" },
    ];
    const bSchema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "bstat", type: "string" },
    ];
    const cSchema: ColumnSchema[] = [
      { name: "alt", type: "string" },
      { name: "cstat", type: "string" },
    ];
    await service.createTable(a, aSchema, [
      ["X", "X2"],
      ["Y", "Y2"],
    ]);
    await service.createTable(b, bSchema, [["X", "bX"]]);
    await service.createTable(c, cSchema, [["X2", "cX"]]);

    const anchor: JoinTableInput = {
      tableName: a,
      readTableName: a,
      rowCount: 2,
      schema: aSchema,
    };
    const tb: JoinTableInput = {
      tableName: b,
      readTableName: b,
      rowCount: 1,
      schema: bSchema,
    };
    const tc: JoinTableInput = {
      tableName: c,
      readTableName: c,
      rowCount: 1,
      schema: cSchema,
    };
    // a↔b via name (0.9, joins first); a↔c via alt (0.7, joins second).
    const abKey = match(ref(a, "name"), ref(b, "name"), 0.9, "ab");
    const acKey = match(ref(a, "alt"), ref(c, "alt"), 0.7, "ac");

    const { tableName, columns, joinOrder } = await applyJoinChain(
      service,
      0,
      [anchor, tb, tc],
      [acKey, abKey], // out of order; planner sorts by confidence.
    );
    expect(joinOrder).toEqual([a, b, c]);
    // Both keys folded to the anchor side; status columns carried.
    const names = columns.map((cc) => cc.name);
    expect(names).toEqual(["name", "alt", "bstat", "cstat"]);

    const rows = await service.query<{
      name: string;
      alt: string;
      bstat: string | null;
      cstat: string | null;
    }>(`SELECT name, alt, bstat, cstat FROM ${qi(tableName)} ORDER BY name`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "X",
      alt: "X2",
      bstat: "bX",
      cstat: "cX",
    });
    // Unmatched anchor row keeps NULLs for both joined tables (LEFT JOIN).
    expect(rows[1]).toMatchObject({ name: "Y", bstat: null, cstat: null });
  });

  it("prefixes a colliding non-key column with its source table (Req 7.10)", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("ca");
    const b = uniqueName("cb");
    const aSchema: ColumnSchema[] = [
      { name: "id", type: "string" },
      { name: "label", type: "string" },
    ];
    const bSchema: ColumnSchema[] = [
      { name: "bid", type: "string" },
      { name: "label", type: "string" },
    ];
    await service.createTable(a, aSchema, [["1", "anchorLabel"]]);
    await service.createTable(b, bSchema, [["1", "joinedLabel"]]);

    const anchor: JoinTableInput = {
      tableName: a,
      readTableName: a,
      rowCount: 1,
      schema: aSchema,
    };
    const joined: JoinTableInput = {
      tableName: b,
      readTableName: b,
      rowCount: 1,
      schema: bSchema,
    };
    const key = match(ref(a, "id"), ref(b, "bid"), 0.9);

    const { tableName, columns } = await applyJoinChain(
      service,
      0,
      [anchor, joined],
      [key],
    );
    const names = columns.map((c) => c.name);
    expect(names).toContain("label");
    expect(names).toContain(`${b}_label`);
    const rows = await service.query<Record<string, unknown>>(
      `SELECT * FROM ${qi(tableName)}`,
    );
    expect(rows[0].label).toBe("anchorLabel");
    expect(rows[0][`${b}_label`]).toBe("joinedLabel");
  });

  it("never mutates the originals (Req 7.12)", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("orig_a");
    const b = uniqueName("orig_b");
    const schema: ColumnSchema[] = [{ name: "id", type: "string" }];
    await service.createTable(a, schema, [["1"], ["2"]]);
    await service.createTable(b, schema, [["1"]]);
    const anchor: JoinTableInput = {
      tableName: a,
      readTableName: a,
      rowCount: 2,
      schema,
    };
    const joined: JoinTableInput = {
      tableName: b,
      readTableName: b,
      rowCount: 1,
      schema,
    };
    await applyJoinChain(
      service,
      0,
      [anchor, joined],
      [match(ref(a, "id"), ref(b, "id"), 0.9)],
    );
    const aCount = await service.getRowCount(a);
    const bCount = await service.getRowCount(b);
    expect(aCount).toBe(2);
    expect(bCount).toBe(1);
  });

  it("handles adversarial table/column names safely (Property 13)", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName('we"ird');
    const b = uniqueName("plain");
    const aSchema: ColumnSchema[] = [{ name: 'k"ey', type: "string" }];
    const bSchema: ColumnSchema[] = [
      { name: "k", type: "string" },
      { name: "v", type: "string" },
    ];
    await service.createTable(a, aSchema, [["match"]]);
    await service.createTable(b, bSchema, [["match", "ok"]]);
    await service.query(`CREATE TABLE join_sentinel (x INTEGER)`);

    const anchor: JoinTableInput = {
      tableName: a,
      readTableName: a,
      rowCount: 1,
      schema: aSchema,
    };
    const joined: JoinTableInput = {
      tableName: b,
      readTableName: b,
      rowCount: 1,
      schema: bSchema,
    };
    const key = match(ref(a, 'k"ey'), ref(b, "k"), 0.9);

    const { tableName } = await applyJoinChain(
      service,
      0,
      [anchor, joined],
      [key],
    );
    const sentinel = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'join_sentinel'`,
    );
    expect(Number(sentinel[0].n)).toBe(1);
    const rows = await service.query<{ v: string | null }>(
      `SELECT v FROM ${qi(tableName)}`,
    );
    expect(rows[0].v).toBe("ok");
  });
});
