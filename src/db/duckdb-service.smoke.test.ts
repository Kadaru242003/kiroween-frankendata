// DuckDBService sanity round-trip (task 10.1).
//
// A minimal, non-property check that the service — built around an injected
// node-blocking connection adapter — can create an explicitly typed table,
// insert coerced rows, round-trip previews/counts, and fall back to VARCHAR
// when a column's values don't match its inferred type. The exhaustive
// property-based coverage lives in tasks 10.2–10.5.
//
// Environment note: as with the init smoke test, DuckDB-WASM's *browser*
// bundles need a real browser worker environment unavailable under Vitest, so
// this test wraps the *node-blocking* bundle (same engine, synchronous API,
// filesystem-located assets) in a DuckDBConnectionAdapter and injects it. The
// application uses the browser bundle via createDuckDBService() + init().

import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { IntakeFailure } from "../core/intake-failure";
import type { ColumnSchema } from "../core/types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "./duckdb-service";

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

/** Create an in-memory node-blocking connection adapter + a disposer. */
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
  return {
    adapter,
    dispose: () => {
      conn.close();
      db.reset();
    },
  };
}

describe("DuckDBService sanity round-trip (node bundle)", () => {
  it("creates a typed table, inserts coerced rows, and serves previews/counts", async () => {
    const { adapter, dispose } = await createNodeAdapter();
    try {
      const service = createDuckDBService(adapter);
      await service.init(); // no-op when a connection is injected

      const schema: ColumnSchema[] = [
        { name: "amount", type: "number" },
        { name: "active", type: "boolean" },
        { name: "day", type: "date" },
        { name: "label", type: "string" },
      ];
      const rows = [
        ["$1,234.56", "yes", "01/05/2026", "alpha"],
        ["12%", "no", "2026-01-05", "N/A"], // "N/A" is a NullToken → stored NULL
        ["-3.14", "true", "Jan 5, 2026", "it's a test"], // embedded quote
      ];

      const loaded = await service.createTable("sales", schema, rows);

      // Types used are the inferred ones (no fallback here).
      expect(loaded.schema).toEqual(schema);
      expect(loaded.rowCount).toBe(3);
      expect(await service.getRowCount("sales")).toBe(3);

      const preview = await service.getPreviewRows("sales", 20);
      expect(preview).toHaveLength(3);

      // Coercion checks: currency → DOUBLE, percent → decimal fraction,
      // dates → ISO DATE, NullToken → NULL, quote escaped.
      const byLabel = (rows2: Record<string, unknown>[]) => rows2;
      const previewRows = byLabel(preview);
      expect(Number(previewRows[0].amount)).toBeCloseTo(1234.56, 2);
      expect(Number(previewRows[1].amount)).toBeCloseTo(0.12, 5);
      expect(Number(previewRows[2].amount)).toBeCloseTo(-3.14, 2);
      expect(previewRows[0].active).toBe(true);
      expect(previewRows[1].active).toBe(false);
      expect(previewRows[2].active).toBe(true);
      expect(previewRows[2].label).toBe("it's a test");
      expect(previewRows[1].label).toBeNull();

      // Dates normalized to the same calendar day regardless of source format.
      const days = (await service.query<{ day: string }>(
        'SELECT CAST("day" AS VARCHAR) AS day FROM sales ORDER BY "label"',
      )).map((r) => r.day);
      expect(days).toContain("2026-01-05");
    } finally {
      dispose();
    }
  });

  it("falls back to VARCHAR for a column whose values don't match its inferred type", async () => {
    const { adapter, dispose } = await createNodeAdapter();
    try {
      const service = createDuckDBService(adapter);

      // Column inferred as number, but one value cannot be coerced → fallback.
      const schema: ColumnSchema[] = [{ name: "val", type: "number" }];
      const rows = [["42"], ["not-a-number"], ["-"]];

      const loaded = await service.createTable("mixed", schema, rows);

      // The column was recreated as string, and the file still loaded (Req 6.7).
      expect(loaded.schema[0].type).toBe("string");
      expect(loaded.rowCount).toBe(3);

      const preview = await service.getPreviewRows("mixed", 20);
      expect(preview.map((r) => r.val)).toEqual(["42", "not-a-number", null]);
    } finally {
      dispose();
    }
  });

  it("wraps unrecoverable failures as a table-load-failed IntakeFailure naming the file", async () => {
    const { adapter, dispose } = await createNodeAdapter();
    try {
      const service = createDuckDBService(adapter);
      await service.createTable("dup", [{ name: "a", type: "string" }], [["x"]]);

      // Creating the same table again is an unrecoverable DDL error → Req 6.8.
      await expect(
        service.createTable("dup", [{ name: "a", type: "string" }], [["y"]]),
      ).rejects.toBeInstanceOf(IntakeFailure);

      try {
        await service.createTable("dup", [{ name: "a", type: "string" }], [["z"]]);
      } catch (err) {
        expect(err).toBeInstanceOf(IntakeFailure);
        const failure = err as IntakeFailure;
        expect(failure.intakeError.kind).toBe("table-load-failed");
        expect(failure.intakeError.stage).toBe("loading");
        expect(failure.intakeError.message).toContain("dup");
      }
    } finally {
      dispose();
    }
  });
});
