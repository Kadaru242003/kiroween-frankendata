/**
 * DuckDB test harness for the Recipes tests (Feature 5). Wraps the
 * node-blocking bundle in a DuckDBConnectionAdapter, including the optional
 * `exportFileBytes` so Parquet export can be tested. Test support only.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
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
  copyFileToBuffer(name: string): Uint8Array;
  dropFile(name: string): void;
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
    async exportFileBytes(copySql: string, virtualFileName: string) {
      // The node runtime writes COPY output to the real file system (relative
      // to the working directory), unlike the browser's virtual file system, so
      // read it back from disk and remove it. Falls back to the DuckDB buffer
      // API when the file is virtual.
      conn.query(copySql);
      try {
        return db.copyFileToBuffer(virtualFileName);
      } catch {
        const bytes = new Uint8Array(fs.readFileSync(virtualFileName));
        return bytes;
      } finally {
        fs.rmSync(virtualFileName, { force: true });
        try {
          db.dropFile(virtualFileName);
        } catch {
          /* may not exist */
        }
      }
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
