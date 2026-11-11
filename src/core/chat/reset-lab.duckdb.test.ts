/**
 * Real-DuckDB tests for lab reset (bug fix: repeated demo reloads).
 *
 * Over a REAL in-memory DuckDB (node-blocking bundle via the same harness as
 * `ask-golden.duckdb.test.ts`), these prove:
 *   - `dropAllTables` removes every base table, never throwing;
 *   - after a reset (dropAllTables + IntakeStore.reset) a fresh load gets the
 *     PLAIN table names again (`monsters`, not `monsters_2`) — the dedup
 *     counter is driven by the store, which reset clears.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { createIntakeController } from "../intake-controller";
import { demoDataLoader } from "../demo-data-loader";
import { IntakeStore } from "../../state/intake-store";
import { dropAllTables } from "./reset-lab";
import type { DuckDBService } from "../types";

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
  return { adapter, dispose: () => { conn.close(); db.reset(); } };
}

async function tableNames(service: DuckDBService): Promise<string[]> {
  const rows = await service.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
  );
  return rows.map((r) => String(r.table_name));
}

describe("dropAllTables + reset (real DuckDB)", () => {
  let dispose: () => void;
  let service: DuckDBService;
  let store: IntakeStore;

  beforeEach(async () => {
    const created = await createNodeAdapter();
    dispose = created.dispose;
    service = createDuckDBService(created.adapter);
    await service.init();
    store = new IntakeStore();
  });

  afterEach(() => dispose?.());

  it("drops every table and returns DuckDB to empty, never throwing", async () => {
    const intake = createIntakeController({ duckDBService: service, store });
    await intake.intake(await demoDataLoader.load());
    expect((await tableNames(service)).length).toBeGreaterThan(0);

    const dropped = await dropAllTables(service);
    expect(dropped.length).toBeGreaterThan(0);
    expect(await tableNames(service)).toEqual([]);

    // Dropping again on an empty catalog is a harmless no-op.
    await expect(dropAllTables(service)).resolves.toEqual([]);
  });

  it("gives plain table names again after load → reset → load (no monsters_2)", async () => {
    const intake = createIntakeController({ duckDBService: service, store });

    // First load: plain names.
    await intake.intake(await demoDataLoader.load());
    expect(await tableNames(service)).toContain("monsters");

    // Reset: drop all tables AND clear the store (which drives name dedup).
    await dropAllTables(service);
    store.reset();
    expect(await tableNames(service)).toEqual([]);

    // Second load after reset: plain names again, NOT monsters_2.
    await intake.intake(await demoDataLoader.load());
    const names = await tableNames(service);
    expect(names).toContain("monsters");
    expect(names.some((n) => /_\d+$/.test(n))).toBe(false);
  });
});
