import { describe, expect, it } from "vitest";
import { createAskController } from "./ask-controller";
import { createFakeSqlProvider } from "./sql-provider";
import { ASK_REPAIR_ERROR_MAX_CHARS, ASK_REPAIR_SQL_MAX_CHARS, type SqlResponse } from "./types";

function make(sql: string, error: Error) {
  const resp: SqlResponse = { sql, explanation: "x" };
  const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: resp } });
  let n = 0;
  const controller = createAskController({
    getQueryableTableNames: () => ["t"],
    runQuery: async () => {
      if (n++ === 0) throw error;
      return { columns: ["a"], rows: [] };
    },
    aiEnabled: true,
    provider,
    buildSchema: async () => ({ tables: [] }),
  });
  return { provider, controller };
}

describe("repair request privacy", () => {
  it("sends a DuckDB conversion error with the cell value removed", async () => {
    const { provider, controller } = make(
      "SELECT CAST(cost AS INTEGER) AS c FROM t",
      new Error(
        "Conversion Error: Could not convert string 'TOP-SECRET-9931' to INT32 when casting from source column \"cost\"\nLINE 1: SELECT CAST(cost AS INTEGER) FROM t\n ^"
      )
    );
    await controller.ask("total cost");
    expect(provider.calls).toHaveLength(2);
    const repair = provider.calls[1].repair;
    expect(repair).toBeDefined();
    expect(repair?.error).toBe(
      "Conversion Error: Could not convert string '<value>' to INT32 when casting from source column '<value>'"
    );
    expect(JSON.stringify(provider.calls[1])).not.toContain("TOP-SECRET-9931");
  });

  it("caps the error and the previous SQL before sending", async () => {
    const longSql = `SELECT '${"a".repeat(ASK_REPAIR_SQL_MAX_CHARS + 500)}' AS c FROM t`;
    const { provider, controller } = make(longSql, new Error("Parser Error: " + "boom ".repeat(400)));
    await controller.ask("q");
    const repair = provider.calls[1].repair;
    expect(repair?.error.length).toBeLessThanOrEqual(ASK_REPAIR_ERROR_MAX_CHARS);
    expect(repair?.previousSql.length).toBeLessThanOrEqual(ASK_REPAIR_SQL_MAX_CHARS);
  });

  it("still sends the failed SQL and a usable error type", async () => {
    const { provider, controller } = make("SELECT nope FROM t", new Error("Binder Error: Referenced column nope not found"));
    await controller.ask("q");
    expect(provider.calls[1].repair?.previousSql).toBe("SELECT nope FROM t");
    expect(provider.calls[1].repair?.error).toMatch(/^Binder Error:/);
  });
});
