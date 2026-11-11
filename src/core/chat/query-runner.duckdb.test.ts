/**
 * Real-DuckDB test for the QueryRunner + DATE/TIMESTAMP display conversion
 * (Feature 3, bug fix).
 *
 * Over a REAL in-memory DuckDB (the node-blocking bundle wrapped in a
 * DuckDBConnectionAdapter — the same harness as `ask-golden.duckdb.test.ts`,
 * because DuckDB-WASM's browser bundles need a worker unavailable under jsdom),
 * this proves the bug is fixed: a DATE column displays as `YYYY-MM-DD` (no time
 * part), a TIMESTAMP column as a full ISO string, the CSV export carries the
 * same strings, a plain BIGINT column is unaffected, and a NULL date shows as
 * "" — none leak raw epoch milliseconds.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { createDuckDbQueryRunner } from "./query-runner";
import { createAskController } from "./ask-controller";
import { toCsv } from "./csv-export";
import type { DuckDBService } from "../types";

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

describe("DuckDbQueryRunner — DATE/TIMESTAMP display conversion (real DuckDB)", () => {
  let dispose: () => void;
  let service: DuckDBService;

  beforeAll(async () => {
    const created = await createNodeAdapter();
    dispose = created.dispose;
    service = createDuckDBService(created.adapter);
    await service.init();

    // A table with a DATE, a TIMESTAMP, a plain BIGINT, and a NULL date row.
    await service.query(
      "CREATE TABLE events (id BIGINT, captured_on DATE, seen_at TIMESTAMP)",
    );
    await service.query(
      "INSERT INTO events VALUES " +
        "(1, DATE '2025-11-30', TIMESTAMP '2025-11-30 14:05:00'), " +
        "(2, DATE '2026-01-05', TIMESTAMP '2026-01-05 00:00:00'), " +
        "(3, NULL, NULL)",
    );
  });

  afterAll(() => dispose?.());

  it("renders DATE as YYYY-MM-DD and TIMESTAMP as full ISO via the controller", async () => {
    const controller = createAskController({
      getQueryableTableNames: () => ["events"],
      runQuery: createDuckDbQueryRunner(service),
      aiEnabled: false,
    });

    const out = await controller.runSql(
      "SELECT captured_on, seen_at, id FROM events ORDER BY id",
      "all events",
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;

    const [dateIdx, tsIdx, idIdx] = [
      out.columns.indexOf("captured_on"),
      out.columns.indexOf("seen_at"),
      out.columns.indexOf("id"),
    ];

    // DATE → date-only string, no time part.
    expect(out.rows[0][dateIdx]).toBe("2025-11-30");
    expect(out.rows[1][dateIdx]).toBe("2026-01-05");
    expect(String(out.rows[0][dateIdx])).not.toMatch(/T|:/);
    // A raw epoch-ms number must NOT leak.
    expect(typeof out.rows[0][dateIdx]).toBe("string");

    // TIMESTAMP → full ISO string on the right day.
    expect(typeof out.rows[0][tsIdx]).toBe("string");
    expect(String(out.rows[0][tsIdx])).toContain("2025-11-30");
    expect(String(out.rows[0][tsIdx])).toContain("T");

    // NULL date → "".
    expect(out.rows[2][dateIdx]).toBe("");

    // Plain BIGINT id is unaffected (a number).
    expect(out.rows[0][idIdx]).toBe(1);

    // CSV export carries the SAME readable strings (not epoch ms).
    const csv = toCsv(out.columns, out.rows);
    expect(csv).toContain("2025-11-30");
    expect(csv).toContain("2026-01-05");
    expect(csv).not.toContain("1764"); // no epoch-ms prefix for these dates
  });

  it("renders MIN/MAX DATE aggregates as YYYY-MM-DD", async () => {
    const controller = createAskController({
      getQueryableTableNames: () => ["events"],
      runQuery: createDuckDbQueryRunner(service),
      aiEnabled: false,
    });

    const out = await controller.runSql(
      "SELECT MIN(captured_on) AS first_seen, MAX(captured_on) AS last_seen FROM events",
      "date range",
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;

    const firstIdx = out.columns.indexOf("first_seen");
    const lastIdx = out.columns.indexOf("last_seen");
    expect(out.rows[0][firstIdx]).toBe("2025-11-30");
    expect(out.rows[0][lastIdx]).toBe("2026-01-05");
    // No time part, no raw epoch ms.
    expect(String(out.rows[0][firstIdx])).not.toMatch(/T|:|\d{10,}/);
  });
});
