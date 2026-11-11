/**
 * DuckDB-backed tests for the rules-only {@link StitchController} wiring
 * (Feature 2, task 9). Runs the real SampleReader → RulesEngine → StitchApplier
 * pipeline against an in-memory DuckDB and verifies:
 *
 *   - computeProposals wires samples → rules match + clean and stores the
 *     ProposalSet (aiUsed=false, no AI provider);
 *   - a datasetVersion change (a new loadId) discards the prior proposals +
 *     decisions, recomputes, and sets the store's `recomputed` flag (Req 3.8);
 *   - applyPlan delegates to the applier and stores the StitchedTable +
 *     pending UndoStep, with the descriptor built from information_schema +
 *     getRowCount (Req 7.11);
 *   - undo delegates to the applier and clears the applied state while leaving
 *     proposals intact (Req 4.3);
 *   - the StitchedTable descriptor's schema/types/row count are correct.
 *
 * ## Environment note (same pattern as the applier DuckDB tests)
 *
 * DuckDB-WASM's browser bundles need a real browser worker environment that is
 * unavailable under Vitest's jsdom runner, so this test wraps the node-blocking
 * bundle in a DuckDBConnectionAdapter and injects it via createDuckDBService. A
 * fresh in-memory DuckDB per test keeps the MVP bundle from carrying state.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ColumnSchema, LoadedTable } from "../types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { StitchStore } from "./stitch-store";
import {
  buildStitchedTableDescriptor,
  computeDatasetVersion,
  createStitchController,
  duckdbTypeToColumnType,
} from "./stitch-controller";
import type { MatchProposal, StitchPlan } from "./types";

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

let serial = 0;
function uniqueName(base: string): string {
  serial += 1;
  return `${base}_${serial}`;
}

function loaded(
  tableName: string,
  schema: ColumnSchema[],
  rowCount: number,
  loadId: number,
): LoadedTable {
  return { loadId, tableName, sourceFileName: tableName, schema, rowCount };
}

describe("computeDatasetVersion", () => {
  it("is the sorted, order-independent list of loadIds", () => {
    const schema: ColumnSchema[] = [{ name: "a", type: "string" }];
    const t1 = loaded("a", schema, 1, 3);
    const t2 = loaded("b", schema, 1, 1);
    const t3 = loaded("c", schema, 1, 2);
    expect(computeDatasetVersion([t1, t2, t3])).toBe("1,2,3");
    // Re-ordering the same tables yields the same version.
    expect(computeDatasetVersion([t3, t1, t2])).toBe("1,2,3");
    // A re-dropped file (new loadId) changes the version.
    expect(computeDatasetVersion([t1, t2, loaded("c", schema, 1, 9)])).toBe(
      "1,3,9",
    );
    expect(computeDatasetVersion([])).toBe("");
  });
});

describe("duckdbTypeToColumnType", () => {
  it("maps DuckDB types back to ColumnType (case/space-insensitive)", () => {
    expect(duckdbTypeToColumnType("DOUBLE")).toBe("number");
    expect(duckdbTypeToColumnType(" boolean ")).toBe("boolean");
    expect(duckdbTypeToColumnType("DATE")).toBe("date");
    expect(duckdbTypeToColumnType("VARCHAR")).toBe("string");
    // Anything unrecognized is the safe string default.
    expect(duckdbTypeToColumnType("DECIMAL(10,2)")).toBe("string");
  });
});

describe("StitchController over a real DuckDB", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeEach(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterEach(() => {
    dispose?.();
  });

  it("computeProposals wires samples → rules match + clean and stores the set (aiUsed=false)", async () => {
    const service = createDuckDBService(adapter);
    await service.init();

    const monsters = uniqueName("monsters");
    const experiments = uniqueName("experiments");
    const mSchema: ColumnSchema[] = [{ name: "name", type: "string" }];
    const eSchema: ColumnSchema[] = [{ name: "name", type: "string" }];
    // Overlapping creature names so a match surfaces; the repeated whitespace
    // in one row gives the cleaning engine something to propose.
    await service.createTable(monsters, mSchema, [
      ["Swamp Wraith"],
      ["Bog Golem"],
      ["Night Howler"],
      ["  Swamp   Wraith  "],
    ]);
    await service.createTable(experiments, eSchema, [
      ["Swamp Wraith"],
      ["Bog Golem"],
      ["Night Howler"],
    ]);

    const store = new StitchStore();
    const tables = [
      loaded(monsters, mSchema, 4, 1),
      loaded(experiments, eSchema, 3, 2),
    ];
    const controller = createStitchController({
      db: service,
      getTables: () => tables,
      store,
    });

    const result = await controller.computeProposals();

    // A match between the two "name" columns is proposed (overlapping values).
    expect(result.aiUsed).toBe(false);
    expect(result.matches.length).toBeGreaterThan(0);
    const nameMatch = result.matches.find(
      (m) =>
        m.left.columnName === "name" && m.right.columnName === "name",
    );
    expect(nameMatch).toBeDefined();
    // The ProposalSet is stored with the derived dataset version; the first
    // compute is NOT a recompute.
    expect(store.getState().proposals).toBe(result);
    expect(store.getDatasetVersion()).toBe("1,2");
    expect(store.getState().recomputed).toBe(false);
  });

  it("selectTable restricts proposals to the checked tables (item 1)", async () => {
    const service = createDuckDBService(adapter);
    await service.init();

    // Three tables, all sharing an overlapping "name" column, so without a
    // filter EVERY pair would match. We check only two and assert the third is
    // never referenced by any proposal.
    const monsters = uniqueName("monsters");
    const experiments = uniqueName("experiments");
    const extra = uniqueName("extra");
    const schema: ColumnSchema[] = [{ name: "name", type: "string" }];
    for (const t of [monsters, experiments, extra]) {
      await service.createTable(t, schema, [
        ["Swamp Wraith"],
        ["Bog Golem"],
        ["Night Howler"],
      ]);
    }

    const store = new StitchStore();
    const tables = [
      loaded(monsters, schema, 3, 1),
      loaded(experiments, schema, 3, 2),
      loaded(extra, schema, 3, 3),
    ];
    // Only monsters + experiments are checked; `extra` is excluded.
    const checked = new Set([monsters, experiments]);
    const controller = createStitchController({
      db: service,
      getTables: () => tables,
      store,
      selectTable: (t) => checked.has(t.tableName),
    });

    const result = await controller.computeProposals();

    // No match references the unchecked table on either side.
    const touchesExtra = result.matches.some(
      (m) => m.left.tableName === extra || m.right.tableName === extra,
    );
    expect(touchesExtra).toBe(false);
    // No cleaning proposal targets the unchecked table either.
    const cleaningTouchesExtra = result.cleanings.some(
      (c) => c.target.tableName === extra,
    );
    expect(cleaningTouchesExtra).toBe(false);
    // The checked pair still matches, so we didn't just filter everything out.
    const checkedMatch = result.matches.find(
      (m) =>
        (m.left.tableName === monsters && m.right.tableName === experiments) ||
        (m.left.tableName === experiments && m.right.tableName === monsters),
    );
    expect(checkedMatch).toBeDefined();
    // The dataset version derives from the FILTERED set (two loadIds).
    expect(store.getDatasetVersion()).toBe("1,2");
  });

  it("discards prior proposals + decisions and recomputes on a datasetVersion change (Req 3.8)", async () => {
    const service = createDuckDBService(adapter);
    const a = uniqueName("a");
    const b = uniqueName("b");
    const schema: ColumnSchema[] = [{ name: "id", type: "string" }];
    await service.createTable(a, schema, [["1"], ["2"]]);
    await service.createTable(b, schema, [["1"], ["2"]]);

    const store = new StitchStore();
    let tables = [loaded(a, schema, 2, 1), loaded(b, schema, 2, 2)];
    const controller = createStitchController({
      db: service,
      getTables: () => tables,
      store,
    });

    const first = await controller.computeProposals();
    expect(store.getDatasetVersion()).toBe("1,2");
    expect(store.getState().recomputed).toBe(false);

    // The user records a decision on the current proposals.
    const someProposalId = first.matches[0]?.id ?? "x";
    store.setDecision({ proposalId: someProposalId, decision: "approved" });
    expect(store.getState().decisions).not.toEqual({});

    // The loaded-table set changes: b re-dropped gets a fresh loadId (3).
    tables = [loaded(a, schema, 2, 1), loaded(b, schema, 2, 3)];
    await controller.computeProposals();

    // Decisions were discarded, the version updated, and recomputed flagged.
    expect(store.getState().decisions).toEqual({});
    expect(store.getDatasetVersion()).toBe("1,3");
    expect(store.getState().recomputed).toBe(true);
  });

  it("applyPlan delegates to the applier and stores the StitchedTable + pending UndoStep (Req 7.11, 4.2)", async () => {
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
      ["Night Howler", "50"],
    ]);
    await service.createTable(experiments, eSchema, [
      ["Swamp Wraith", "sedated"],
      ["Bog Golem", "active"],
    ]);

    const store = new StitchStore();
    const tables = [
      loaded(monsters, mSchema, 3, 1),
      loaded(experiments, eSchema, 2, 2),
    ];
    const controller = createStitchController({
      db: service,
      getTables: () => tables,
      store,
    });

    const nameMatch: MatchProposal = {
      id: "m",
      left: { tableName: monsters, columnName: "name", type: "string" },
      right: { tableName: experiments, columnName: "name", type: "string" },
      confidence: 0.9,
      reason: "names",
      source: "rules",
      components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
    };
    const plan: StitchPlan = {
      anchorTableName: monsters,
      joinKeysByPair: {},
      approvedMatches: [nameMatch],
      approvedCleanings: [],
    };

    const stitched = await controller.applyPlan(plan);

    // The result table is the applier's stitch_1_result, LEFT JOIN kept all 3
    // anchor rows.
    expect(stitched.tableName).toBe("stitch_1_result");
    expect(stitched.rowCount).toBe(3);
    // Descriptor schema matches the real result columns: anchor's name+weight,
    // then experiments.status (its key column is folded into the anchor's name).
    const colNames = stitched.schema.map((c) => c.name);
    expect(colNames).toContain("name");
    expect(colNames).toContain("weight");
    expect(colNames).toContain("status");
    // Types came back from information_schema.
    expect(stitched.schema.find((c) => c.name === "weight")?.type).toBe(
      "number",
    );
    expect(stitched.schema.find((c) => c.name === "status")?.type).toBe(
      "string",
    );

    // Store holds the descriptor, the plan, and the pending undo step.
    expect(store.getState().stitchedTable).toBe(stitched);
    expect(store.getState().plan).toBe(plan);
    expect(store.getState().pendingUndo?.createdTableNames).toContain(
      "stitch_1_result",
    );
  });

  it("undo delegates to the applier (drops created tables) and clears applied state; originals survive", async () => {
    const service = createDuckDBService(adapter);
    await service.init();
    const a = uniqueName("a");
    const b = uniqueName("b");
    const schema: ColumnSchema[] = [{ name: "id", type: "string" }];
    await service.createTable(a, schema, [["1"], ["2"]]);
    await service.createTable(b, schema, [["1"]]);

    const store = new StitchStore();
    const tables = [loaded(a, schema, 2, 1), loaded(b, schema, 1, 2)];
    const controller = createStitchController({
      db: service,
      getTables: () => tables,
      store,
    });

    // Compute proposals first so we can assert they survive undo.
    const proposals = await controller.computeProposals();

    const plan: StitchPlan = {
      anchorTableName: a,
      joinKeysByPair: {},
      approvedMatches: [
        {
          id: "m",
          left: { tableName: a, columnName: "id", type: "string" },
          right: { tableName: b, columnName: "id", type: "string" },
          confidence: 0.9,
          reason: "ids",
          source: "rules",
          components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
        },
      ],
      approvedCleanings: [],
    };

    const stitched = await controller.applyPlan(plan);
    expect(await tableExists(service, stitched.tableName)).toBe(true);

    await controller.undo();

    // The created result table was dropped and the applied state cleared.
    expect(await tableExists(service, stitched.tableName)).toBe(false);
    expect(store.getState().stitchedTable).toBeNull();
    expect(store.getState().pendingUndo).toBeNull();
    // Proposals survive the undo (user can re-apply).
    expect(store.getState().proposals).toBe(proposals);
    // Originals are untouched.
    expect(await service.getRowCount(a)).toBe(2);
    expect(await service.getRowCount(b)).toBe(1);
  });

  it("buildStitchedTableDescriptor reads schema (ordered) + row count from the DB", async () => {
    const service = createDuckDBService(adapter);
    await service.init();
    const t = uniqueName("desc");
    const schema: ColumnSchema[] = [
      { name: "label", type: "string" },
      { name: "amount", type: "number" },
      { name: "active", type: "boolean" },
      { name: "day", type: "date" },
    ];
    await service.createTable(t, schema, [
      ["alpha", "1.5", "true", "2026-01-05"],
      ["beta", "2.5", "false", "2026-02-06"],
    ]);

    const descriptor = await buildStitchedTableDescriptor(service, t);
    expect(descriptor.tableName).toBe(t);
    expect(descriptor.rowCount).toBe(2);
    // Columns come back in ordinal order with the mapped ColumnTypes.
    expect(descriptor.schema).toEqual(schema);
  });
});

/** Does a table exist in the catalog? */
async function tableExists(
  service: ReturnType<typeof createDuckDBService>,
  name: string,
): Promise<boolean> {
  const rows = await service.query<{ n: number | bigint }>(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = '${name.replace(
      /'/g,
      "''",
    )}'`,
  );
  return Number(rows[0].n) === 1;
}
