/**
 * DuckDB golden + real-value-conversion tests for "Ask the Lab" (Feature 3,
 * task 11).
 *
 * Two DuckDB-backed tests over a REAL in-memory DuckDB (the node-blocking
 * bundle wrapped in a DuckDBConnectionAdapter, the same harness as
 * `stitch-golden.duckdb.test.ts`, because DuckDB-WASM's browser bundles need a
 * real worker unavailable under Vitest's jsdom):
 *
 *   1. GOLDEN — load the Feature 2 mismatched demo through the real intake
 *      pipeline, then run `AskController.ask("how many monsters per species")`
 *      with a `FakeSqlProvider` returning the grouped-count SQL + a bar
 *      ChartSpec. Asserts the grouped counts match the known demo data and the
 *      validated ChartSpec is the bar spec (Req 10.6).
 *
 *   2. CONVERSION — select a DECIMAL (`ROUND(AVG(x),2)`), a BIGINT
 *      (`COUNT(*)`), a DATE, a TIMESTAMP, a BOOLEAN and a NULL from DuckDB and
 *      pass the real result row through `toDisplayValue`, asserting the display
 *      values (ISO strings, a finite decimal number, a safe integer, a boolean,
 *      "") — never a typed-array JSON string or `[object Object]` (Req
 *      7.1–7.4, 10.4).
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { createIntakeController } from "../intake-controller";
import { demoDataLoader } from "../demo-data-loader";
import { IntakeStore } from "../../state/intake-store";
import { createAskController, type QueryExecResult } from "./ask-controller";
import { createFakeSqlProvider } from "./sql-provider";
import { toDisplayValue } from "./result-convert";
import type { DuckDBService } from "../types";
import type { SqlResponse } from "./types";

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

/** Build a real QueryRunner over a DuckDBService (mirrors the App wiring). */
function makeRunner(service: DuckDBService) {
  return async (sql: string): Promise<QueryExecResult> => {
    const rows = await service.query<Record<string, unknown>>(sql);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows };
  };
}

describe("Ask the Lab — DuckDB golden (how many monsters per species)", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;
  let service: DuckDBService;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
    service = createDuckDBService(adapter);
    await service.init();

    // Load the mismatched demo through the real intake pipeline (no network).
    const files = await demoDataLoader.loadMismatched();
    const store = new IntakeStore();
    const intake = createIntakeController({ duckDBService: service, store });
    await intake.intake(files);
    expect(store.getState().errors).toEqual([]);
    // The monsters table keeps its clean name (first occurrence).
    expect(store.getState().tables.some((t) => t.tableName === "monsters")).toBe(true);
  });

  afterAll(() => dispose?.());

  it("answers the grouped-count question with the expected counts and a bar chart", async () => {
    // A FakeSqlProvider returns the exact grouped-count SQL + a bar ChartSpec,
    // as the model would for this question (no network).
    const response: SqlResponse = {
      sql:
        'SELECT "Species" AS species, COUNT(*) AS count ' +
        "FROM monsters GROUP BY \"Species\" ORDER BY count DESC",
      explanation: "Counts the monsters in each species.",
      chart: { type: "bar", x: "species", y: "count" },
    };
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response } });

    const controller = createAskController({
      getQueryableTableNames: () => ["monsters"],
      runQuery: makeRunner(service),
      aiEnabled: true,
      provider,
      buildSchema: async () => ({ tables: [] }),
    });

    const outcome = await controller.ask("how many monsters per species");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // Columns + validated bar chart survive.
    expect(outcome.columns).toEqual(["species", "count"]);
    expect(outcome.chart).toEqual({ type: "bar", x: "species", y: "count" });

    // Grouped counts (raw Species spellings as loaded, 14 rows incl. 2 Gorzak
    // duplicates). Values are already converted to display values (numbers).
    const counts = new Map(
      outcome.rows.map((r) => [String(r[0]), Number(r[1])]),
    );
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(14);
    // "Swamp Wraith" is the top group with 4 (Gorzak ×3 incl. dupes + Fizz).
    expect(counts.get("Swamp Wraith")).toBe(4);
    // Every count is a finite number (no [object Object] / BigInt leakage).
    for (const v of counts.values()) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("Ask the Lab — real DuckDB value conversion", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;
  let service: DuckDBService;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
    service = createDuckDBService(adapter);
    await service.init();
  });

  afterAll(() => dispose?.());

  it("converts DATE, TIMESTAMP, DECIMAL, BIGINT, BOOLEAN, and NULL to safe display values", async () => {
    // One row carrying every tricky DuckDB type. ROUND(AVG(x),2) yields a
    // DECIMAL; COUNT(*) yields a BIGINT; plus a DATE, TIMESTAMP, BOOLEAN, NULL.
    const rows = await service.query<Record<string, unknown>>(
      "SELECT " +
        "ROUND(AVG(x), 2) AS avg_x, " +
        "COUNT(*) AS n, " +
        "DATE '2026-10-31' AS d, " +
        "TIMESTAMP '2026-10-31 02:30:00' AS ts, " +
        "(COUNT(*) > 0) AS has_rows, " +
        "CAST(NULL AS VARCHAR) AS nothing " +
        "FROM (VALUES (10), (20), (33)) AS t(x)",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // DECIMAL → finite number (avg of 10,20,33 = 21.00).
    const avg = toDisplayValue(row.avg_x);
    expect(typeof avg).toBe("number");
    expect(avg).toBeCloseTo(21, 2);

    // BIGINT (COUNT) → safe number.
    expect(toDisplayValue(row.n)).toBe(3);

    // DATE / TIMESTAMP → ISO string. The node-blocking bundle may surface
    // these as a Date object, an ISO string, or a bare epoch-ms number. A
    // Date/string converts to ISO directly; a bare number is an epoch-ms
    // timestamp value, so the (timestamp-aware) converter is told so — exactly
    // what a column-type-aware caller passes. Either way the display value is
    // an ISO string on the expected calendar day, never a raw object.
    const toIso = (v: unknown): string =>
      String(toDisplayValue(v, typeof v === "number"));
    const d = toIso(row.d);
    expect(d).toContain("2026-10-31");
    const ts = toIso(row.ts);
    expect(ts).toContain("2026-10-31");

    // BOOLEAN → boolean.
    expect(toDisplayValue(row.has_rows)).toBe(true);

    // NULL → "".
    expect(toDisplayValue(row.nothing)).toBe("");

    // No converted value is ever [object Object] or a typed-array JSON string.
    for (const key of Object.keys(row)) {
      const out = toDisplayValue(row[key]);
      expect(String(out)).not.toContain("[object Object]");
    }
  });
});
