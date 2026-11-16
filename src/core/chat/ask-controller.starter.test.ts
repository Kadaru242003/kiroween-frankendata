/**
 * Fix-starter: starter chips always run their own rule-built SQL locally (never
 * the AI, never the network), survive one transient failure, and typed
 * questions that fail say WHY in words that carry no SQL, name or value.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CHIP_MESSAGE,
  EXECUTION_MESSAGE,
  PROVIDER_MESSAGE,
  READ_ONLY_MESSAGE,
  TIMEOUT_MESSAGE,
  UNKNOWN_TABLE_MESSAGE,
  createAskController,
  type AskControllerDeps,
  type AskDiagnostic,
} from "./ask-controller";
import { generateBusinessChips } from "./business-chips";
import { createFakeSqlProvider } from "./sql-provider";
import type { QueryableTable, SchemaSummary, SqlResponse } from "./types";

const TABLES = ["stitch_1_result", "crm_customers"];
const schema: SchemaSummary = { tables: [] } as unknown as SchemaSummary;
const ok = { columns: ["region", "invoiced_revenue"], rows: [{ region: "EMEA", invoiced_revenue: 5 }] };

function deps(over: Partial<AskControllerDeps> = {}): AskControllerDeps {
  return {
    getQueryableTableNames: () => TABLES,
    runQuery: vi.fn(async () => ok),
    aiEnabled: true,
    buildSchema: async () => schema,
    chipRetryDelayMs: 0,
    ...over,
  };
}
const response = (sql: string): SqlResponse => ({ sql, explanation: "x" }) as SqlResponse;
const stitched: QueryableTable = {
  tableName: "stitch_1_result",
  columns: [
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
  ],
};

describe("starter chips never use the AI, even with AI on", () => {
  it("runSql makes no provider call, whether the chip works or fails", async () => {
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: response("SELECT 1") } });
    const good = createAskController(deps({ provider }));
    const [chip] = generateBusinessChips([stitched]);
    expect(chip.question).toBe("What is the invoiced revenue by region in stitch_1_result?");
    const out = await good.runSql(chip.sql, chip.question, chip.chart);
    expect(out.kind).toBe("ok");
    const broken = createAskController(
      deps({ provider, runQuery: vi.fn(async () => { throw new Error("boom"); }) })
    );
    expect((await broken.runSql(chip.sql, chip.question, chip.chart)).kind).toBe("error");
    expect(provider.calls).toHaveLength(0);
  });

  it("every business chip passes the validator for the tables it was made from", async () => {
    const crm: QueryableTable = {
      tableName: "crm_customers",
      columns: [{ name: "Region", type: "string" }, { name: "Monthly_Revenue", type: "number" }],
    };
    const billing: QueryableTable = {
      tableName: "billing_invoices",
      columns: [{ name: "invoice_date", type: "date" }, { name: "amount", type: "number" }, { name: "status", type: "string" }],
    };
    const tables = [stitched, crm, billing];
    const chips = generateBusinessChips(tables);
    expect(chips.length).toBeGreaterThanOrEqual(3);
    const runQuery = vi.fn(async () => ok);
    const ctrl = createAskController(
      deps({ getQueryableTableNames: () => tables.map((t) => t.tableName), runQuery, aiEnabled: false })
    );
    for (const chip of chips) {
      expect((await ctrl.runSql(chip.sql, chip.question, chip.chart)).kind, chip.question).toBe("ok");
    }
  });
});

describe("a starter chip survives one transient failure", () => {
  it("retries once after a DuckDB error", async () => {
    const runQuery = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue(ok);
    const events: AskDiagnostic[] = [];
    const ctrl = createAskController(deps({ runQuery, onDiagnostic: (d) => events.push(d) }));
    const out = await ctrl.runSql("SELECT region FROM stitch_1_result", "q");
    expect(out.kind).toBe("ok");
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ path: "chip", category: "execution" }]);
  });

  it("retries once with a freshly read allowlist (the table list was refreshing)", async () => {
    const names = vi.fn().mockReturnValueOnce(["crm_customers"]).mockReturnValue(TABLES);
    const events: AskDiagnostic[] = [];
    const ctrl = createAskController(deps({ getQueryableTableNames: names, onDiagnostic: (d) => events.push(d) }));
    const out = await ctrl.runSql("SELECT region FROM stitch_1_result", "q");
    expect(out.kind).toBe("ok");
    expect(events).toEqual([{ path: "chip", category: "rejected:unknown-table" }]);
  });

  it("gives a plain message when both tries fail, and runs at most twice", async () => {
    const runQuery = vi.fn(async () => { throw new Error("always"); });
    const ctrl = createAskController(deps({ runQuery }));
    const out = await ctrl.runSql("SELECT region FROM stitch_1_result", "q");
    expect(out).toEqual({ kind: "error", message: CHIP_MESSAGE });
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});

describe("typed questions say why they failed", () => {
  const ask = (d: Partial<AskControllerDeps>) => createAskController(deps(d)).ask("revenue by region?");
  const answering = (sql: string) =>
    createFakeSqlProvider({ behavior: { kind: "respond", response: response(sql) } });

  it("a statement that is not read-only gets the read-only reason", async () => {
    for (const sql of ["DROP TABLE stitch_1_result", "SELECT 1; SELECT 2", "SELECT * FROM read_csv('x.csv')", "COPY stitch_1_result TO 'x'"]) {
      expect(await ask({ provider: answering(sql) }), sql).toEqual({ kind: "error", message: READ_ONLY_MESSAGE });
    }
  });

  it("a table that is not loaded gets its own reason", async () => {
    expect(await ask({ provider: answering("SELECT * FROM secret_table") })).toEqual({
      kind: "error",
      message: UNKNOWN_TABLE_MESSAGE,
    });
  });

  it("an error that survives the repair gets the execution reason", async () => {
    const runQuery = vi.fn(async () => { throw new Error("Binder Error: column x not found"); });
    const provider = answering("SELECT x FROM stitch_1_result");
    expect(await ask({ provider, runQuery })).toEqual({ kind: "error", message: EXECUTION_MESSAGE });
    expect(provider.calls).toHaveLength(2);
  });

  it("a rejected repair gets the read-only reason", async () => {
    const runQuery = vi.fn(async () => { throw new Error("Binder Error"); });
    let n = 0;
    const provider = createFakeSqlProvider({
      behavior: { kind: "fn", fn: () => response(n++ === 0 ? "SELECT x FROM stitch_1_result" : "DELETE FROM stitch_1_result") },
    });
    expect(await ask({ provider, runQuery })).toEqual({ kind: "error", message: READ_ONLY_MESSAGE });
  });

  it("a provider timeout says it took too long; other failures say so; 429 and 503 stay unavailable", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(await ask({ provider: createFakeSqlProvider({ behavior: { kind: "throw", error: abort } }) })).toEqual({
      kind: "error",
      message: TIMEOUT_MESSAGE,
    });
    expect(
      await ask({ provider: createFakeSqlProvider({ behavior: { kind: "throw", error: new Error("SQL proxy returned status 502") } }) })
    ).toEqual({ kind: "error", message: PROVIDER_MESSAGE });
    expect(
      await ask({ provider: createFakeSqlProvider({ behavior: { kind: "throw", error: new Error("SQL proxy returned status 503") } }) })
    ).toEqual({ kind: "ai-unavailable" });
  });

  it("a timeout on the repair call says it took too long", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    let n = 0;
    const provider = createFakeSqlProvider({
      behavior: { kind: "fn", fn: () => { if (n++ === 0) return response("SELECT x FROM stitch_1_result"); throw abort; } },
    });
    const runQuery = vi.fn(async () => { throw new Error("Binder Error"); });
    expect(await ask({ provider, runQuery })).toEqual({ kind: "error", message: TIMEOUT_MESSAGE });
  });

  it("messages carry no SQL, no table or value, and no dash", () => {
    for (const m of [READ_ONLY_MESSAGE, UNKNOWN_TABLE_MESSAGE, EXECUTION_MESSAGE, TIMEOUT_MESSAGE, PROVIDER_MESSAGE, CHIP_MESSAGE]) {
      expect(m).not.toMatch(/[\u2013\u2014]|SELECT|stitch_|crm_|billing/i);
    }
  });
});

describe("diagnostics report a category only", () => {
  it("never include SQL text, names, values or the question", async () => {
    const events: AskDiagnostic[] = [];
    const secretSql = "SELECT * FROM secret_table WHERE ssn = '123-45-6789'";
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: response(secretSql) } });
    const ctrl = createAskController(deps({ provider, onDiagnostic: (d) => events.push(d) }));
    await ctrl.ask("what is the ssn of Jane Doe?");
    expect(events).toEqual([{ path: "ask", category: "rejected:unknown-table" }]);
    const text = JSON.stringify(events);
    for (const leak of ["secret_table", "123-45-6789", "ssn", "Jane", "SELECT"]) expect(text).not.toContain(leak);
  });

  it("a throwing diagnostics hook never changes an answer", async () => {
    const ctrl = createAskController(
      deps({ onDiagnostic: () => { throw new Error("hook"); }, runQuery: vi.fn(async () => { throw new Error("x"); }) })
    );
    expect(await ctrl.runSql("SELECT region FROM stitch_1_result", "q")).toEqual({ kind: "error", message: CHIP_MESSAGE });
  });
});
