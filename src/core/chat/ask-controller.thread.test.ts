import { describe, expect, it } from "vitest";
import { createAskController } from "./ask-controller";
import { createFakeSqlProvider } from "./sql-provider";
import type { SqlResponse, ThreadTurn } from "./types";

const THREAD: ThreadTurn[] = [{ question: "q1", sql: "SELECT 1", columns: ["a"], rowCount: 2 }];
const RESP: SqlResponse = { sql: "SELECT day, n FROM t", explanation: "x" };

function make(rows: Record<string, unknown>[], dates = new Set(["day"])) {
  const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: RESP } });
  const controller = createAskController({
    getQueryableTableNames: () => ["t"],
    runQuery: async () => ({ columns: ["day", "n"], rows, dateColumns: dates }),
    aiEnabled: true,
    provider,
    buildSchema: async () => ({ tables: [] }),
  });
  return { provider, controller };
}

describe("ask controller with a thread", () => {
  it("sends the thread only when it is not empty", async () => {
    const { provider, controller } = make([]);
    await controller.ask("sort that", THREAD);
    await controller.ask("fresh");
    expect(provider.calls[0].thread).toEqual(THREAD);
    expect("thread" in provider.calls[1]).toBe(false);
  });
  it("returns ai-unavailable with AI off and sends nothing", async () => {
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: RESP } });
    const c = createAskController({ getQueryableTableNames: () => ["t"], runQuery: async () => ({ columns: [], rows: [] }), aiEnabled: false, provider });
    expect((await c.ask("x", THREAD)).kind).toBe("ai-unavailable");
    expect(provider.calls).toHaveLength(0);
  });
  it("gives a temporal plus numeric result a line chart and temporalColumns", async () => {
    const { controller } = make([{ day: 1_767_225_600_000, n: 1 }, { day: 1_767_312_000_000, n: 3 }]);
    const out = await controller.ask("trend");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.chart).toEqual({ type: "line", x: "day", y: "n" });
      expect(out.temporalColumns).toEqual(["day"]);
    }
  });
  it("keeps the thread on the repair request", async () => {
    let n = 0;
    const provider = createFakeSqlProvider({ behavior: { kind: "respond", response: RESP } });
    const c = createAskController({
      getQueryableTableNames: () => ["t"],
      runQuery: async () => { if (n++ === 0) throw new Error("boom"); return { columns: ["a"], rows: [] }; },
      aiEnabled: true,
      provider,
      buildSchema: async () => ({ tables: [] }),
    });
    await c.ask("x", THREAD);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].repair).toBeDefined();
    expect(provider.calls[1].thread).toEqual(THREAD);
  });
});
