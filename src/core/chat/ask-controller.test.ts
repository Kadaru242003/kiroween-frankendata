/**
 * Unit tests for the AskController (Feature 3, task 5).
 *
 * Covers design "AskController flow" + "Executor hard row cap" and Requirements
 * 2.4, 5.8, 5.9, 5.10, 6.1–6.6, 9.4: chip path, AI-off, repair-once success,
 * repair-still-fails → error, 429/503 → ai-unavailable, never throws, the
 * fetch-cap wrap, and the drop-invalid-chart hook.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createAskController,
  wrapWithFetchCap,
  type QueryExecResult,
  type AskControllerDeps,
} from "./ask-controller";
import { createFakeSqlProvider } from "./sql-provider";
import { ASK_MAX_FETCH_ROWS, type SqlResponse } from "./types";

const TABLES = ["monsters", "experiments"];

/** A query runner that returns canned rows for any SQL. */
function okRunner(result: QueryExecResult) {
  return vi.fn(async () => result);
}

/** A query runner that throws a DuckDB-style error. */
function errorRunner(message: string) {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

function baseDeps(overrides: Partial<AskControllerDeps> = {}): AskControllerDeps {
  return {
    getQueryableTableNames: () => TABLES,
    runQuery: okRunner({ columns: ["n"], rows: [{ n: 1 }] }),
    aiEnabled: false,
    ...overrides,
  };
}

describe("wrapWithFetchCap", () => {
  it("wraps the SQL with the fetch-row cap", () => {
    expect(wrapWithFetchCap("SELECT 1")).toBe(
      `SELECT * FROM (SELECT 1) AS q LIMIT ${ASK_MAX_FETCH_ROWS}`
    );
  });
});

describe("runSql (chip path)", () => {
  it("validates, executes, converts, returns ok", async () => {
    const runQuery = okRunner({ columns: ["c"], rows: [{ c: 5n }] });
    const ctrl = createAskController(baseDeps({ runQuery }));
    const out = await ctrl.runSql("SELECT COUNT(*) AS c FROM monsters", "count");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.rows).toEqual([[5]]); // BigInt → number
      expect(out.explanation).toBe("count");
      // The executed SQL is wrapped with the fetch cap.
      expect(runQuery).toHaveBeenCalledWith(
        expect.stringContaining(`LIMIT ${ASK_MAX_FETCH_ROWS}`)
      );
    }
  });

  it("returns a friendly error (never throws) when the SQL is rejected", async () => {
    const ctrl = createAskController(baseDeps());
    const out = await ctrl.runSql("DROP TABLE monsters", "bad");
    expect(out.kind).toBe("error");
  });

  it("flags capped when the result hits ASK_MAX_FETCH_ROWS", async () => {
    const rows = Array.from({ length: ASK_MAX_FETCH_ROWS }, (_, i) => ({ n: i }));
    const ctrl = createAskController(baseDeps({ runQuery: okRunner({ columns: ["n"], rows }) }));
    const out = await ctrl.runSql("SELECT n FROM monsters", "all");
    expect(out.kind === "ok" && out.capped).toBe(true);
  });
});

describe("ask (free-form)", () => {
  it("returns ai-unavailable when AI is disabled (no network)", async () => {
    const provider = createFakeSqlProvider();
    const ctrl = createAskController(
      baseDeps({ aiEnabled: false, provider, buildSchema: async () => ({ tables: [] }) })
    );
    const out = await ctrl.ask("how many monsters");
    expect(out.kind).toBe("ai-unavailable");
    expect(provider.calls).toHaveLength(0);
  });

  it("answers via the provider on the first call", async () => {
    const response: SqlResponse = {
      sql: "SELECT species, COUNT(*) AS count FROM monsters GROUP BY species",
      explanation: "monsters per species",
      chart: { type: "bar", x: "species", y: "count" },
    };
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response } });
    const runQuery = okRunner({
      columns: ["species", "count"],
      rows: [{ species: "ghost", count: 3 }],
    });
    const ctrl = createAskController(
      baseDeps({ aiEnabled: true, provider, buildSchema: async () => ({ tables: [] }), runQuery })
    );
    const out = await ctrl.ask("how many monsters per species");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.chart).toEqual(response.chart); // valid bar chart kept
      expect(out.columns).toEqual(["species", "count"]);
    }
    expect(provider.calls).toHaveLength(1);
  });

  it("makes exactly ONE repair call on a DuckDB error, then succeeds", async () => {
    const good: SqlResponse = { sql: "SELECT 1 AS n FROM monsters", explanation: "fixed" };
    const bad: SqlResponse = { sql: "SELECT bogus FROM monsters", explanation: "first" };
    let call = 0;
    const provider = createFakeSqlProvider({
      behavior: {
        kind: "fn",
        fn: () => (call++ === 0 ? bad : good),
      },
    });
    // First execution throws; the repaired one succeeds.
    let run = 0;
    const runQuery = vi.fn(async () => {
      if (run++ === 0) throw new Error("Binder Error: bogus not found");
      return { columns: ["n"], rows: [{ n: 1 }] };
    });
    const ctrl = createAskController(
      baseDeps({ aiEnabled: true, provider, buildSchema: async () => ({ tables: [] }), runQuery })
    );
    const out = await ctrl.ask("broken question");
    expect(out.kind).toBe("ok");
    expect(provider.calls).toHaveLength(2); // original + one repair
    expect(provider.calls[1].repair).toEqual({
      previousSql: bad.sql,
      error: "Binder Error: bogus not found",
    });
  });

  it("returns a friendly error when the repair also fails", async () => {
    const bad: SqlResponse = { sql: "SELECT bogus FROM monsters", explanation: "x" };
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: bad } });
    const runQuery = errorRunner("Binder Error: still broken");
    const ctrl = createAskController(
      baseDeps({ aiEnabled: true, provider, buildSchema: async () => ({ tables: [] }), runQuery })
    );
    const out = await ctrl.ask("still broken");
    expect(out.kind).toBe("error");
    expect(provider.calls).toHaveLength(2); // original + one repair, then stop
  });

  it("does NOT repair when the model's SQL is rejected by the validator", async () => {
    const forbidden: SqlResponse = { sql: "DROP TABLE monsters", explanation: "evil" };
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: forbidden } });
    const runQuery = okRunner({ columns: [], rows: [] });
    const ctrl = createAskController(
      baseDeps({ aiEnabled: true, provider, buildSchema: async () => ({ tables: [] }), runQuery })
    );
    const out = await ctrl.ask("delete everything");
    expect(out.kind).toBe("error");
    expect(provider.calls).toHaveLength(1); // no repair for a validation reject
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("maps a 429/503-like provider failure to ai-unavailable", async () => {
    const provider = createFakeSqlProvider({
      behavior: { kind: "throw", error: new Error("AI proxy returned status 503") },
    });
    const ctrl = createAskController(
      baseDeps({ aiEnabled: true, provider, buildSchema: async () => ({ tables: [] }) })
    );
    const out = await ctrl.ask("anything");
    expect(out.kind).toBe("ai-unavailable");
  });

  it("maps an unexpected provider failure to a friendly error", async () => {
    const provider = createFakeSqlProvider({
      behavior: { kind: "throw", error: new Error("TypeError: boom") },
    });
    const ctrl = createAskController(
      baseDeps({ aiEnabled: true, provider, buildSchema: async () => ({ tables: [] }) })
    );
    const out = await ctrl.ask("anything");
    expect(out.kind).toBe("error");
  });
});

describe("chart wiring through the controller", () => {
  it("keeps a valid bar chart on the ok outcome, drops an invalid one but still returns the table", async () => {
    const withGoodChart: SqlResponse = {
      sql: "SELECT species, COUNT(*) AS count FROM monsters GROUP BY species",
      explanation: "per species",
      chart: { type: "bar", x: "species", y: "count" },
    };
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: withGoodChart } });
    const runQuery = okRunner({
      columns: ["species", "count"],
      rows: [{ species: "ghost", count: 3 }],
    });
    const ctrl = createAskController(
      baseDeps({ aiEnabled: true, provider, buildSchema: async () => ({ tables: [] }), runQuery })
    );
    const ok = await ctrl.ask("per species");
    expect(ok.kind === "ok" && ok.chart).toEqual({ type: "bar", x: "species", y: "count" });

    // A chart whose y column is missing is dropped; the table still shows.
    const badChart: SqlResponse = {
      sql: "SELECT species FROM monsters",
      explanation: "names",
      chart: { type: "bar", x: "species", y: "count" },
    };
    const provider2 = createFakeSqlProvider({ behavior: { kind: "respond", response: badChart } });
    const ctrl2 = createAskController(
      baseDeps({
        aiEnabled: true,
        provider: provider2,
        buildSchema: async () => ({ tables: [] }),
        runQuery: okRunner({ columns: ["species"], rows: [{ species: "ghost" }] }),
      })
    );
    const out2 = await ctrl2.ask("names");
    expect(out2.kind).toBe("ok");
    expect(out2.kind === "ok" && out2.chart).toBeUndefined();
  });
});
