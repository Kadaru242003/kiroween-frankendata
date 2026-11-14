/**
 * Creates the in-memory DuckDB service under Node, using the same node-blocking
 * DuckDB-WASM bundle the existing tests use, wrapped by the existing
 * `createDuckDBService`. No network access.
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../src/db/duckdb-service";
import type { DuckDBService } from "../../src/core/types";

interface ConnectionLike {
  query(text: string): { toArray(): Array<{ toJSON(): Record<string, unknown> }> };
  close(): void;
}
interface InstanceLike {
  instantiate(): Promise<unknown>;
  open(config: { path?: string; accessMode?: number }): void;
  connect(): ConnectionLike;
  reset(): void;
}
interface NodeModule {
  createDuckDB: (b: unknown, l: unknown, r: unknown) => Promise<InstanceLike>;
  NODE_RUNTIME: unknown;
  VoidLogger: new () => unknown;
  DuckDBAccessMode: { READ_WRITE: number };
}

export interface NodeDuckDB {
  service: DuckDBService;
  dispose: () => void;
}

export async function createNodeDuckDB(): Promise<NodeDuckDB> {
  const require = createRequire(import.meta.url);
  const entry = "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs";
  const duckdb = require(entry) as NodeModule;
  const dist = path.dirname(require.resolve(entry));
  const bundles = {
    mvp: {
      mainModule: path.join(dist, "duckdb-mvp.wasm"),
      mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"),
    },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
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
