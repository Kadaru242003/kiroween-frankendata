/**
 * Pure-builder unit tests for the StitchApplier join chain (Feature 2, task
 * 8.2). These assert the planning + generated `CREATE TABLE … AS SELECT` shape
 * WITHOUT a database:
 *
 *   - anchor selection (most rows) and the override (Req 7.2);
 *   - LEFT JOIN ordering by descending approved-match confidence (Req 7.3);
 *   - default join-key selection per pair (highest-confidence match, Req 7.4);
 *   - non-key matches surfaced as same-meaning columns (Req 7.5);
 *   - the key column appears once under the anchor-side name (Req 7.6);
 *   - output-name collisions prefixed with the source table name (Req 7.10);
 *   - keys read from the (post-cleaning) copies so comparison is post-cleaning
 *     (Req 7.8);
 *   - the escaping invariant (Property 13): identifiers via quoteIdent.
 *
 * The behavioral "it actually joins the rows / LEFT JOIN floor / post-cleaning
 * keys really match" assertions live in the DuckDB-backed companion
 * `stitch-applier.join.duckdb.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { ColumnRef, MatchProposal } from "./types";
import {
  buildJoinChainSql,
  planJoinChain,
  resultTableName,
  selectAnchorTable,
  type JoinTableInput,
} from "./stitch-applier";

/** Build a ColumnRef shorthand. */
function ref(tableName: string, columnName: string): ColumnRef {
  return { tableName, columnName, type: "string" };
}

/** Build a minimal MatchProposal connecting two columns at a given confidence. */
function match(
  left: ColumnRef,
  right: ColumnRef,
  confidence: number,
  id = `match:${left.tableName}.${left.columnName}=${right.tableName}.${right.columnName}`
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

/** A join-table input reading its original (no cleaning). */
function table(
  tableName: string,
  columns: string[],
  rowCount: number,
  readTableName = tableName
): JoinTableInput {
  return {
    tableName,
    readTableName,
    rowCount,
    schema: columns.map((name) => ({ name, type: "string" as const })),
  };
}

describe("resultTableName", () => {
  it("formats stitch_<n>_result", () => {
    expect(resultTableName(0)).toBe("stitch_0_result");
    expect(resultTableName(7)).toBe("stitch_7_result");
  });

  it("rejects non-integer / negative counters", () => {
    expect(() => resultTableName(-1)).toThrow(RangeError);
    expect(() => resultTableName(2.5)).toThrow(RangeError);
  });
});

describe("selectAnchorTable", () => {
  it("defaults to the table with the most rows (Req 7.2)", () => {
    const tables = [
      table("a", ["id"], 10),
      table("b", ["id"], 100),
      table("c", ["id"], 50),
    ];
    expect(selectAnchorTable(tables).tableName).toBe("b");
  });

  it("breaks row-count ties by table name ascending (deterministic)", () => {
    const tables = [table("z", ["id"], 10), table("a", ["id"], 10)];
    expect(selectAnchorTable(tables).tableName).toBe("a");
  });

  it("honors a valid override (Req 7.2)", () => {
    const tables = [table("a", ["id"], 10), table("b", ["id"], 100)];
    expect(selectAnchorTable(tables, "a").tableName).toBe("a");
  });

  it("ignores an override that names no table", () => {
    const tables = [table("a", ["id"], 10), table("b", ["id"], 100)];
    expect(selectAnchorTable(tables, "nope").tableName).toBe("b");
  });

  it("throws on an empty table list", () => {
    expect(() => selectAnchorTable([])).toThrow(RangeError);
  });
});

describe("planJoinChain — ordering, keys, columns", () => {
  it("LEFT JOINs remaining tables in descending confidence order (Req 7.3)", () => {
    // anchor = monsters (most rows). Two candidates join via matches of
    // different confidence; the higher-confidence pair joins first.
    const monsters = table("monsters", ["mid", "name"], 100);
    const experiments = table("experiments", ["eid", "name"], 20);
    const sightings = table("sightings", ["sid", "name"], 10);
    const mExp = match(ref("monsters", "name"), ref("experiments", "name"), 0.9);
    const mSig = match(ref("monsters", "name"), ref("sightings", "name"), 0.7);

    const plan = planJoinChain(
      0,
      [monsters, experiments, sightings],
      [mSig, mExp] // deliberately out of order; planner must sort.
    );
    expect(plan.anchor.tableName).toBe("monsters");
    expect(plan.steps.map((s) => s.table.tableName)).toEqual([
      "experiments",
      "sightings",
    ]);
  });

  it("uses the highest-confidence approved match as the pair key (Req 7.4)", () => {
    const a = table("a", ["x", "y"], 100);
    const b = table("b", ["x", "y"], 10);
    const low = match(ref("a", "y"), ref("b", "y"), 0.6, "low");
    const high = match(ref("a", "x"), ref("b", "x"), 0.9, "high");
    const plan = planJoinChain(0, [a, b], [low, high]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].keyMatch.id).toBe("high");
    // The other approved match becomes a same-meaning column.
    expect(plan.steps[0].sameMeaningMatches.map((m) => m.id)).toEqual(["low"]);
  });

  it("folds the key column once under the anchor-side name (Req 7.6)", () => {
    const a = table("a", ["key", "av"], 100);
    const b = table("b", ["bkey", "bv"], 10);
    const key = match(ref("a", "key"), ref("b", "bkey"), 0.9);
    const plan = planJoinChain(0, [a, b], [key]);
    const names = plan.columns.map((c) => c.name);
    // anchor "key" present; b's "bkey" (the right key col) omitted.
    expect(names).toContain("key");
    expect(names).not.toContain("bkey");
    expect(names).toEqual(["key", "av", "bv"]);
  });

  it("prefixes colliding output names with the source table (Req 7.10)", () => {
    const a = table("a", ["id", "name"], 100);
    const b = table("b", ["bid", "name"], 10);
    const key = match(ref("a", "id"), ref("b", "bid"), 0.9);
    const plan = planJoinChain(0, [a, b], [key]);
    const names = plan.columns.map((c) => c.name);
    // both tables have a non-key "name" → b's is prefixed.
    expect(names).toContain("name"); // anchor's
    expect(names).toContain("b_name"); // collision-prefixed
  });

  it("omits tables that connect through no approved match", () => {
    const a = table("a", ["id"], 100);
    const b = table("b", ["id"], 10);
    const orphan = table("orphan", ["id"], 5);
    const key = match(ref("a", "id"), ref("b", "id"), 0.9);
    const plan = planJoinChain(0, [a, b, orphan], [key]);
    expect(plan.steps.map((s) => s.table.tableName)).toEqual(["b"]);
    expect(plan.columns.some((c) => c.sourceTableName === "orphan")).toBe(false);
  });

  it("includes the anchor alone when there are no approved matches", () => {
    const a = table("a", ["id", "v"], 100);
    const b = table("b", ["id"], 10);
    const plan = planJoinChain(0, [a, b], []);
    expect(plan.steps).toHaveLength(0);
    expect(plan.columns.map((c) => c.name)).toEqual(["id", "v"]);
  });
});

describe("buildJoinChainSql — generated DDL", () => {
  it("emits a CREATE TABLE … AS SELECT LEFT JOIN chain reading the copies (Req 7.8)", () => {
    // monsters is cleaned (reads its clean copy); experiments reads its original.
    const monsters: JoinTableInput = {
      tableName: "monsters",
      readTableName: "stitch_0_clean_monsters",
      rowCount: 100,
      schema: [
        { name: "name", type: "string" },
        { name: "weight", type: "number" },
      ],
    };
    const experiments = table("experiments", ["name", "status"], 20);
    const key = match(ref("monsters", "name"), ref("experiments", "name"), 0.9);

    const { createSql, tableName, joinOrder } = buildJoinChainSql(
      0,
      [monsters, experiments],
      [key]
    );
    expect(tableName).toBe("stitch_0_result");
    expect(joinOrder).toEqual(["monsters", "experiments"]);
    // Reads the CLEANED copy for monsters (post-cleaning keys, Req 7.8).
    expect(createSql).toContain(
      'FROM "stitch_0_clean_monsters" AS "monsters"'
    );
    // LEFT JOIN with the pair key on the post-cleaning columns.
    expect(createSql).toContain(
      'LEFT JOIN "experiments" AS "experiments" ON ' +
        '"monsters"."name" = "experiments"."name"'
    );
    // Key column emitted once under the anchor name; collision-free others.
    expect(createSql).toContain('"monsters"."name" AS "name"');
    expect(createSql).toContain('"monsters"."weight" AS "weight"');
    expect(createSql).toContain('"experiments"."status" AS "status"');
    // Right-side key column NOT projected.
    expect(createSql).not.toContain('AS "experiments_name"');
  });

  it("prefixes a colliding non-key column with its source table (Req 7.10)", () => {
    const a = table("a", ["id", "label"], 100);
    const b = table("b", ["bid", "label"], 10);
    const key = match(ref("a", "id"), ref("b", "bid"), 0.9);
    const { createSql } = buildJoinChainSql(0, [a, b], [key]);
    expect(createSql).toContain('"a"."label" AS "label"');
    expect(createSql).toContain('"b"."label" AS "b_label"');
  });
});

describe("escaping invariant (Property 13): adversarial names", () => {
  it("doubles embedded quotes in every table/column identifier", () => {
    const a: JoinTableInput = {
      tableName: 'ta"ble',
      readTableName: 'stitch_0_clean_ta"ble',
      rowCount: 100,
      schema: [{ name: 'co"l', type: "string" }],
    };
    const b: JoinTableInput = {
      tableName: "b",
      readTableName: "b",
      rowCount: 10,
      schema: [{ name: "bc", type: "string" }],
    };
    const key = match(ref('ta"ble', 'co"l'), ref("b", "bc"), 0.9);
    const { createSql } = buildJoinChainSql(0, [a, b], [key]);
    // embedded quotes are doubled in the alias, the read name, and the column.
    expect(createSql).toContain('"stitch_0_clean_ta""ble" AS "ta""ble"');
    expect(createSql).toContain('"ta""ble"."co""l"');
    // every double-quote in the SQL is part of a balanced pair.
    const quotes = (createSql.match(/"/g) ?? []).length;
    expect(quotes % 2).toBe(0);
  });
});
