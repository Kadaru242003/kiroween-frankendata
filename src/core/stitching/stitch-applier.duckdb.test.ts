/**
 * DuckDB-backed tests for the StitchApplier cleaned-copy executor (Feature 2,
 * task 8.1). These run the generated DDL/DML against a real in-memory DuckDB
 * and assert the behavioral guarantees:
 *
 *   - each cleaning kind (whitespace, case, category, outliers, duplicate-rows)
 *     produces a correct cleaned copy;
 *   - the ORIGINAL table is never mutated (Req 4.1);
 *   - column TYPES are preserved in the cleaned copy;
 *   - adversarial values (embedded quotes, injection payloads) are handled
 *     safely — they land as data, not SQL (Property 13).
 *
 * ## Environment note (same pattern as cleaning-rules.duckdb.test.ts)
 *
 * DuckDB-WASM's browser bundles need a real browser worker environment that is
 * unavailable under Vitest's jsdom runner, so this test wraps the node-blocking
 * bundle in a DuckDBConnectionAdapter and injects it via createDuckDBService.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ColumnSchema } from "../types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import {
  applyCleanedCopy,
  groupApprovedForTable,
  type ApprovedCleaning,
} from "./stitch-applier";
import type { CleaningProposal } from "./types";

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

const EMPTY: ApprovedCleaning = {
  columnProposals: [],
  outlierColumns: [],
  dedupe: false,
};

/** Quote an identifier for the hand-written assertion queries in this test. */
function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

let serialCounter = 0;
/** A fresh source-table name per test so copies never collide across `it`s. */
function uniqueName(base: string): string {
  serialCounter += 1;
  return `${base}_${serialCounter}`;
}

describe("StitchApplier cleaned copies over a real DuckDB", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterAll(() => {
    dispose?.();
  });

  it("trims and collapses whitespace without changing case (Req 2.1)", async () => {
    const service = createDuckDBService(adapter);
    await service.init();
    const src = uniqueName("ws");
    const schema: ColumnSchema[] = [{ name: "species", type: "string" }];
    await service.createTable(src, schema, [
      ["  Swamp   Wraith "],
      ["Bog Golem"],
    ]);

    const whitespace: CleaningProposal = {
      id: `clean:whitespace:${src}.species`,
      target: { tableName: src, columnName: "species" },
      kind: "whitespace-case",
      before: "  Swamp   Wraith ",
      after: "Swamp Wraith",
      reason: "ws",
    };
    const copy = await applyCleanedCopy(service, 0, src, schema, {
      ...EMPTY,
      columnProposals: [whitespace],
    });

    const rows = await service.query<{ species: string }>(
      `SELECT species FROM "${copy}" ORDER BY species`
    );
    expect(rows.map((r) => r.species)).toEqual(["Bog Golem", "Swamp Wraith"]);

    // Original untouched (Req 4.1).
    const original = await service.query<{ species: string }>(
      `SELECT species FROM "${src}" ORDER BY rowid`
    );
    expect(original[0].species).toBe("  Swamp   Wraith ");
  });

  it("standardizes differing casing via the CASE map (Req 2.1)", async () => {
    const service = createDuckDBService(adapter);
    const src = uniqueName("case");
    const schema: ColumnSchema[] = [{ name: "species", type: "string" }];
    await service.createTable(src, schema, [
      ["Swamp Wraith"],
      ["swamp wraith"],
      ["Bog Golem"],
    ]);
    const caseProposal: CleaningProposal = {
      id: `clean:case:${src}.species`,
      target: { tableName: src, columnName: "species" },
      kind: "whitespace-case",
      before: "swamp wraith",
      after: "Swamp Wraith",
      reason: "case",
      variantMap: { "swamp wraith": "Swamp Wraith" },
    };
    const copy = await applyCleanedCopy(service, 0, src, schema, {
      ...EMPTY,
      columnProposals: [caseProposal],
    });
    const rows = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM "${copy}" WHERE species = 'Swamp Wraith'`
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it("maps category variants to the canonical literal (Req 2.2)", async () => {
    const service = createDuckDBService(adapter);
    const src = uniqueName("cat");
    const schema: ColumnSchema[] = [{ name: "kind", type: "string" }];
    await service.createTable(src, schema, [
      ["Swamp Wraith"],
      ["swamp-wraith"],
      ["swamp wraith"],
    ]);
    const category: CleaningProposal = {
      id: `clean:category:${src}.kind`,
      target: { tableName: src, columnName: "kind" },
      kind: "category-standardize",
      before: "swamp-wraith",
      after: "Swamp Wraith",
      reason: "cat",
      canonical: "Swamp Wraith",
      variantMap: {
        "swamp-wraith": "Swamp Wraith",
        "swamp wraith": "Swamp Wraith",
      },
    };
    const copy = await applyCleanedCopy(service, 0, src, schema, {
      ...EMPTY,
      columnProposals: [category],
    });
    const rows = await service.query<{ kind: string; n: number | bigint }>(
      `SELECT kind, COUNT(*) AS n FROM "${copy}" GROUP BY kind`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("Swamp Wraith");
    expect(Number(rows[0].n)).toBe(3);
  });

  it("adds an is_outlier BOOLEAN column, removes no rows (Req 2.5, 2.6)", async () => {
    const service = createDuckDBService(adapter);
    const src = uniqueName("out");
    const schema: ColumnSchema[] = [{ name: "weight", type: "number" }];
    const base = Array.from({ length: 10 }, (_, i) => [String(10 + i)]);
    await service.createTable(src, schema, [...base, ["1000"], ["-500"]]);

    const outlier: CleaningProposal = {
      id: `clean:outliers:${src}.weight`,
      target: { tableName: src, columnName: "weight" },
      kind: "outliers",
      before: {},
      after: {},
      reason: "out",
    };
    const approved = groupApprovedForTable(schema, [outlier]);
    const copy = await applyCleanedCopy(service, 0, src, schema, approved);

    // No rows removed.
    const total = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM "${copy}"`
    );
    expect(Number(total[0].n)).toBe(12);

    // Exactly the two extremes flagged.
    const flagged = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM "${copy}" WHERE is_outlier`
    );
    expect(Number(flagged[0].n)).toBe(2);

    // is_outlier is a BOOLEAN column.
    const cols = await service.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns ` +
        `WHERE table_name = '${copy}' AND column_name = 'is_outlier'`
    );
    expect(cols[0].data_type.toUpperCase()).toBe("BOOLEAN");
  });

  it("dedupes keep-first with normalized partitioning (Req 2.4)", async () => {
    const service = createDuckDBService(adapter);
    const src = uniqueName("dup");
    const schema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "kind", type: "string" },
    ];
    await service.createTable(src, schema, [
      ["Ghoul", "undead"],
      [" Ghoul ", "undead"], // whitespace dup of row 1 → collapses in.
      ["Wraith", "spirit"],
      ["Wraith", "spirit"], // exact dup.
      ["Ogre", "giant"],
    ]);
    const dup: CleaningProposal = {
      id: `clean:duplicate-rows:${src}`,
      target: { tableName: src },
      kind: "duplicate-rows",
      before: { rowCount: 5 },
      after: { rowCount: 3 },
      reason: "dup",
    };
    const copy = await applyCleanedCopy(service, 0, src, schema, {
      ...EMPTY,
      dedupe: true,
    });
    const total = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM "${copy}"`
    );
    expect(Number(total[0].n)).toBe(3);
    // keep-first: the first "Ghoul" surface form survives, not " Ghoul ".
    const ghoul = await service.query<{ name: string }>(
      `SELECT name FROM "${copy}" WHERE trim(name) = 'Ghoul'`
    );
    expect(ghoul).toHaveLength(1);
    expect(ghoul[0].name).toBe("Ghoul");
    void dup;
  });

  it("combines outliers + dedupe correctly", async () => {
    const service = createDuckDBService(adapter);
    const src = uniqueName("combo");
    const schema: ColumnSchema[] = [{ name: "v", type: "number" }];
    const base = Array.from({ length: 10 }, (_, i) => [String(10 + i)]);
    // Two identical extreme rows → one survives dedupe but is still an outlier.
    await service.createTable(src, schema, [...base, ["5000"], ["5000"]]);
    const approved: ApprovedCleaning = {
      ...EMPTY,
      outlierColumns: [{ name: "v", type: "number" }],
      dedupe: true,
    };
    const copy = await applyCleanedCopy(service, 0, src, schema, approved);
    const total = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM "${copy}"`
    );
    expect(Number(total[0].n)).toBe(11); // one of the two 5000s removed
    const flagged = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM "${copy}" WHERE is_outlier`
    );
    expect(Number(flagged[0].n)).toBe(1);
  });

  it("preserves column types in the cleaned copy", async () => {
    const service = createDuckDBService(adapter);
    const src = uniqueName("types");
    const schema: ColumnSchema[] = [
      { name: "name", type: "string" },
      { name: "weight", type: "number" },
      { name: "sedated", type: "boolean" },
      { name: "captured", type: "date" },
    ];
    await service.createTable(src, schema, [
      ["A", "1", "true", "2026-01-05"],
    ]);
    const copy = await applyCleanedCopy(service, 0, src, schema, EMPTY);
    const cols = await service.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns ` +
        `WHERE table_name = '${copy}' ORDER BY ordinal_position`
    );
    const typeByName = Object.fromEntries(
      cols.map((c) => [c.column_name, c.data_type.toUpperCase()])
    );
    expect(typeByName).toEqual({
      name: "VARCHAR",
      weight: "DOUBLE",
      sedated: "BOOLEAN",
      captured: "DATE",
    });
  });

  it("handles adversarial names and values safely (Property 13)", async () => {
    const service = createDuckDBService(adapter);
    // Adversarial table name, column name, and a value with a quote + payload.
    const src = uniqueName('we"ird');
    const schema: ColumnSchema[] = [{ name: 'co"l', type: "string" }];
    const evil = "x'); DROP TABLE sentinel;--";
    await service.createTable(src, schema, [[evil], ["O'Brien"]]);

    // A sentinel table that must still exist afterwards (proves no injection).
    await service.query(`CREATE TABLE sentinel (x INTEGER)`);

    const category: CleaningProposal = {
      id: "c",
      target: { tableName: src, columnName: 'co"l' },
      kind: "category-standardize",
      before: evil,
      after: "clean",
      reason: "cat",
      canonical: "clean",
      variantMap: { [evil]: "clean", "O'Brien": "clean" },
    };
    const copy = await applyCleanedCopy(service, 0, src, schema, {
      ...EMPTY,
      columnProposals: [category],
    });

    // Sentinel survived → payload never executed.
    const sentinel = await service.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'sentinel'`
    );
    expect(Number((sentinel[0] as { n: number | bigint }).n)).toBe(1);

    // Both variant values mapped to the canonical. The copy name and column
    // name both carry an embedded quote, so they must be re-quoted (doubled)
    // when referenced here too.
    const rows = await service.query<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM ${qi(copy)} WHERE ${qi('co"l')} = 'clean'`
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});
