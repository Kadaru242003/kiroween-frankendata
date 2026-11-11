/**
 * Pure-unit tests for the top-level StitchApplier lifecycle (Feature 2, task
 * 8.3) — the per-session apply counter, undo recording/drops, and fan-out
 * reporting — driven by a lightweight fake {@link DuckDBService} that records
 * the SQL it is asked to run. These assert the orchestration contract WITHOUT a
 * real database:
 *
 *   - the counter is monotonic (starts at 1, never reused) and is embedded in
 *     EVERY created name — both `stitch_<n>_clean_<name>` and `stitch_<n>_result`
 *     (design: "Table naming convention");
 *   - the recorded {@link UndoStep} captures EXACTLY the tables created by that
 *     apply, cleaned copies first then the result (Req 4.2);
 *   - `undo()` issues `DROP TABLE IF EXISTS` for exactly those names and nothing
 *     else, and never touches an un-prefixed original (Req 4.3, 7.12);
 *   - repeated apply/undo cycles stay independent (fresh counter each time);
 *   - the fan-out counts report anchor-before vs. result-after (Req 7.9).
 *
 * The behavioral "it really drops the tables / originals survive / the join
 * actually fans out" assertions live in the DuckDB-backed companion
 * `stitch-applier.lifecycle.duckdb.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { ColumnSchema, DuckDBService, LoadedTable } from "../types";
import {
  createStitchApplier,
  FIRST_APPLY_COUNTER,
} from "./stitch-applier";
import type { ColumnRef, MatchProposal, StitchPlan } from "./types";

/**
 * A fake DuckDBService recording every SQL string and answering getRowCount
 * from a caller-provided map keyed by table name (so fan-out can be exercised
 * without a real join). Only the methods the applier uses are meaningful.
 */
function fakeDb(rowCounts: Record<string, number> = {}): {
  db: DuckDBService;
  sql: string[];
} {
  const sql: string[] = [];
  const db: DuckDBService = {
    async init() {},
    async createTable(tableName: string, schema: ColumnSchema[]) {
      return {
        loadId: 0,
        tableName,
        sourceFileName: tableName,
        schema,
        rowCount: 0,
      } satisfies LoadedTable;
    },
    async getRowCount(tableName: string) {
      return rowCounts[tableName] ?? 0;
    },
    async getPreviewRows() {
      return [];
    },
    async query<T = Record<string, unknown>>(text: string) {
      sql.push(text);
      return [] as T[];
    },
  };
  return { db, sql };
}

function loaded(
  tableName: string,
  columns: string[],
  rowCount: number
): LoadedTable {
  return {
    loadId: 0,
    tableName,
    sourceFileName: tableName,
    schema: columns.map((name) => ({ name, type: "string" as const })),
    rowCount,
  };
}

function ref(tableName: string, columnName: string): ColumnRef {
  return { tableName, columnName, type: "string" };
}

function match(
  left: ColumnRef,
  right: ColumnRef,
  confidence: number,
  id = `m:${left.tableName}.${left.columnName}=${right.tableName}.${right.columnName}`
): MatchProposal {
  return {
    id,
    left,
    right,
    confidence,
    reason: "test",
    source: "rules",
    components: { nameSim: confidence, typeCompat: 1, valueOverlap: confidence },
  };
}

const EMPTY_PLAN = (anchor: string): StitchPlan => ({
  anchorTableName: anchor,
  joinKeysByPair: {},
  approvedMatches: [],
  approvedCleanings: [],
});

describe("createStitchApplier — counter + naming", () => {
  it("starts the per-session counter at 1", () => {
    const { db } = fakeDb();
    const applier = createStitchApplier(db);
    expect(applier.nextCounter()).toBe(FIRST_APPLY_COUNTER);
    expect(FIRST_APPLY_COUNTER).toBe(1);
  });

  it("embeds the counter in the result name and increments it per apply", async () => {
    const { db } = fakeDb({ a: 2 });
    const applier = createStitchApplier(db);
    const tables = [loaded("a", ["id"], 2)];

    const r1 = await applier.apply(EMPTY_PLAN("a"), tables);
    expect(r1.counter).toBe(1);
    expect(r1.resultTableName).toBe("stitch_1_result");
    expect(applier.nextCounter()).toBe(2);

    const r2 = await applier.apply(EMPTY_PLAN("a"), tables);
    expect(r2.counter).toBe(2);
    expect(r2.resultTableName).toBe("stitch_2_result");
    expect(applier.nextCounter()).toBe(3);
  });

  it("embeds the counter in EVERY created name — clean copies and result", async () => {
    const { db } = fakeDb({ monsters: 3 });
    const applier = createStitchApplier(db);
    const monsters = loaded("monsters", ["name"], 3);
    const experiments = loaded("experiments", ["name", "status"], 2);
    const plan: StitchPlan = {
      anchorTableName: "monsters",
      joinKeysByPair: {},
      approvedMatches: [
        match(ref("monsters", "name"), ref("experiments", "name"), 0.9),
      ],
      // Both tables have an approved cleaning → both get a stitch_<n>_clean_ copy.
      approvedCleanings: [
        {
          id: "c1",
          target: { tableName: "monsters", columnName: "name" },
          kind: "whitespace-case",
          before: " x ",
          after: "x",
          reason: "ws",
        },
        {
          id: "c2",
          target: { tableName: "experiments", columnName: "name" },
          kind: "whitespace-case",
          before: " y ",
          after: "y",
          reason: "ws",
        },
      ],
    };

    const r = await applier.apply(plan, [monsters, experiments]);
    expect(r.undoStep.createdTableNames).toEqual([
      "stitch_1_clean_monsters",
      "stitch_1_clean_experiments",
      "stitch_1_result",
    ]);
    // every created name carries the counter token.
    for (const name of r.undoStep.createdTableNames) {
      expect(name.startsWith("stitch_1_")).toBe(true);
    }
  });

  it("only creates cleaned copies for tables with approved cleanings", async () => {
    const { db } = fakeDb({ a: 5 });
    const applier = createStitchApplier(db);
    const a = loaded("a", ["id"], 5);
    const b = loaded("b", ["id", "v"], 2);
    const plan: StitchPlan = {
      anchorTableName: "a",
      joinKeysByPair: {},
      approvedMatches: [match(ref("a", "id"), ref("b", "id"), 0.9)],
      approvedCleanings: [
        {
          id: "c",
          target: { tableName: "b", columnName: "v" },
          kind: "whitespace-case",
          before: " z ",
          after: "z",
          reason: "ws",
        },
      ],
    };
    const r = await applier.apply(plan, [a, b]);
    // Only b was cleaned; a reads its original. Created = clean_b + result.
    expect(r.undoStep.createdTableNames).toEqual([
      "stitch_1_clean_b",
      "stitch_1_result",
    ]);
  });

  it("rejects applying with no tables", async () => {
    const { db } = fakeDb();
    const applier = createStitchApplier(db);
    await expect(applier.apply(EMPTY_PLAN("a"), [])).rejects.toThrow(RangeError);
  });
});

describe("createStitchApplier — undo", () => {
  it("drops exactly the recorded tables and nothing else (Req 4.3)", async () => {
    const { db, sql } = fakeDb({ a: 2 });
    const applier = createStitchApplier(db);
    const a = loaded("a", ["id"], 2);
    const b = loaded("b", ["id"], 1);
    const plan: StitchPlan = {
      anchorTableName: "a",
      joinKeysByPair: {},
      approvedMatches: [match(ref("a", "id"), ref("b", "id"), 0.9)],
      approvedCleanings: [
        {
          id: "c",
          target: { tableName: "a", columnName: "id" },
          kind: "whitespace-case",
          before: " 1 ",
          after: "1",
          reason: "ws",
        },
      ],
    };
    const r = await applier.apply(plan, [a, b]);
    sql.length = 0; // discard apply DDL; focus on undo DROPs.

    const dropped = await applier.undo();
    expect(dropped).toEqual(r.undoStep.createdTableNames);
    const drops = sql.filter((s) => s.startsWith("DROP TABLE"));
    expect(drops).toEqual([
      'DROP TABLE IF EXISTS "stitch_1_clean_a"',
      'DROP TABLE IF EXISTS "stitch_1_result"',
    ]);
    // undo issued ONLY DROPs — no original was ever referenced.
    expect(sql.every((s) => s.startsWith("DROP TABLE"))).toBe(true);
    expect(sql.some((s) => s.includes('"a"') && !s.includes("clean_a"))).toBe(
      false
    );
  });

  it("is a no-op with nothing pending", async () => {
    const { db, sql } = fakeDb();
    const applier = createStitchApplier(db);
    expect(applier.pendingUndo()).toBeNull();
    expect(await applier.undo()).toEqual([]);
    expect(sql.filter((s) => s.startsWith("DROP TABLE"))).toEqual([]);
  });

  it("clears the pending step after undo", async () => {
    const { db } = fakeDb({ a: 1 });
    const applier = createStitchApplier(db);
    await applier.apply(EMPTY_PLAN("a"), [loaded("a", ["id"], 1)]);
    expect(applier.pendingUndo()).not.toBeNull();
    await applier.undo();
    expect(applier.pendingUndo()).toBeNull();
    expect(await applier.undo()).toEqual([]); // second undo no-ops.
  });

  it("keeps apply/undo cycles independent with a fresh counter each time", async () => {
    const { db } = fakeDb({ a: 1 });
    const applier = createStitchApplier(db);
    const tables = [loaded("a", ["id"], 1)];

    const r1 = await applier.apply(EMPTY_PLAN("a"), tables);
    expect(r1.resultTableName).toBe("stitch_1_result");
    await applier.undo();

    const r2 = await applier.apply(EMPTY_PLAN("a"), tables);
    // Counter never reused even after undo (monotonic, Req / design).
    expect(r2.resultTableName).toBe("stitch_2_result");
    expect(r2.undoStep.createdTableNames).toEqual(["stitch_2_result"]);
  });

  it("re-applying before undo yields a disjoint identifier set (no collision)", async () => {
    const { db } = fakeDb({ a: 1 });
    const applier = createStitchApplier(db);
    const a = loaded("a", ["id"], 1);
    const plan: StitchPlan = {
      anchorTableName: "a",
      joinKeysByPair: {},
      approvedMatches: [],
      approvedCleanings: [
        {
          id: "c",
          target: { tableName: "a", columnName: "id" },
          kind: "whitespace-case",
          before: " 1 ",
          after: "1",
          reason: "ws",
        },
      ],
    };
    const r1 = await applier.apply(plan, [a]);
    const r2 = await applier.apply(plan, [a]); // no undo between applies.
    const intersection = r1.undoStep.createdTableNames.filter((n) =>
      r2.undoStep.createdTableNames.includes(n)
    );
    expect(intersection).toEqual([]);
    expect(r1.undoStep.createdTableNames).toContain("stitch_1_clean_a");
    expect(r2.undoStep.createdTableNames).toContain("stitch_2_clean_a");
  });
});

describe("createStitchApplier — fan-out counts (Req 7.9)", () => {
  it("reports anchor-before vs result-after and flags a fan-out", async () => {
    // Result has MORE rows than the anchor → fannedOut true.
    const { db } = fakeDb({ a: 3, stitch_1_result: 7 });
    const applier = createStitchApplier(db);
    const a = loaded("a", ["id"], 3);
    const b = loaded("b", ["id"], 2);
    const plan: StitchPlan = {
      ...EMPTY_PLAN("a"),
      approvedMatches: [match(ref("a", "id"), ref("b", "id"), 0.9)],
    };
    const r = await applier.apply(plan, [a, b]);
    expect(r.fanOut).toEqual({
      anchorRowCount: 3,
      resultRowCount: 7,
      fannedOut: true,
    });
  });

  it("does not flag a fan-out when the result matches the anchor", async () => {
    const { db } = fakeDb({ a: 3, stitch_1_result: 3 });
    const applier = createStitchApplier(db);
    const a = loaded("a", ["id"], 3);
    const b = loaded("b", ["id"], 2);
    const plan: StitchPlan = {
      ...EMPTY_PLAN("a"),
      approvedMatches: [match(ref("a", "id"), ref("b", "id"), 0.9)],
    };
    const r = await applier.apply(plan, [a, b]);
    expect(r.fanOut.fannedOut).toBe(false);
    expect(r.fanOut.anchorRowCount).toBe(3);
    expect(r.fanOut.resultRowCount).toBe(3);
  });

  it("uses the chosen anchor's row count for the before figure (Req 7.2/7.9)", async () => {
    // Default anchor would be the most-rows table (b), but the plan overrides
    // to a; the fan-out 'before' must reflect the chosen anchor a.
    const { db } = fakeDb({ a: 2, b: 10, stitch_1_result: 2 });
    const applier = createStitchApplier(db);
    const a = loaded("a", ["id"], 2);
    const b = loaded("b", ["id"], 10);
    const plan: StitchPlan = {
      ...EMPTY_PLAN("a"),
      approvedMatches: [match(ref("a", "id"), ref("b", "id"), 0.9)],
    };
    const r = await applier.apply(plan, [a, b]);
    expect(r.joinOrder[0]).toBe("a");
    expect(r.fanOut.anchorRowCount).toBe(2);
  });
});