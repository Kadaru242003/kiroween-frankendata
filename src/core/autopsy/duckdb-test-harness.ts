/**
 * Shared DuckDB test harness for the Autopsy tests (Feature 4).
 *
 * DuckDB-WASM's browser bundles need a real worker unavailable under Vitest's
 * jsdom runner, so DuckDB-backed tests wrap the node-blocking bundle in a
 * DuckDBConnectionAdapter (the same approach as the stitching and Ask the Lab
 * golden tests). This file is test support only and is imported solely by
 * `*.test.ts` files.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import type { DuckDBService } from "../types";

const require = createRequire(import.meta.url);

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

interface DuckDBNodeModule {
  createDuckDB: (
    bundles: unknown,
    logger: unknown,
    runtime: unknown
  ) => Promise<DuckDBNodeInstance>;
  NODE_RUNTIME: unknown;
  VoidLogger: new () => unknown;
  DuckDBAccessMode: { READ_WRITE: number };
}

/** A real in-memory DuckDBService plus a disposer. */
export interface TestDuckDB {
  service: DuckDBService;
  dispose: () => void;
}

/** Create a fresh in-memory DuckDB (node-blocking bundle) wrapped as a service. */
export async function createTestDuckDB(): Promise<TestDuckDB> {
  const duckdb = require(
    "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"
  ) as DuckDBNodeModule;
  const dist = path.dirname(
    require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs")
  );
  const bundles = {
    mvp: {
      mainModule: path.join(dist, "duckdb-mvp.wasm"),
      mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"),
    },
  };
  const db = await duckdb.createDuckDB(
    bundles,
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME
  );
  await db.instantiate();
  db.open({ path: ":memory:", accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  const conn = db.connect();
  const adapter: DuckDBConnectionAdapter = {
    async run(sql: string) {
      return conn.query(sql).toArray().map((r) => r.toJSON());
    },
  };
  const service = createDuckDBService(adapter);
  await service.init();
  return {
    service,
    dispose: () => {
      conn.close();
      db.reset();
    },
  };
}
