/**
 * Unit tests for deterministic starter-question generation (Feature 3, task 4;
 * category rule refined — Part 1).
 *
 * Covers design "StarterChips" and Requirements 2.1–2.4: up to
 * ASK_MAX_STARTER_CHIPS_PER_TABLE chips per table, the rule patterns,
 * applicable-pattern-only generation, determinism, and the refined
 * category-eligibility rule (2..ASK_CATEGORY_DISTINCT_MAX distinct AND
 * distinct ≤ 70% of rows, up to two eligible string columns per table).
 */

import { describe, expect, it } from "vitest";
import {
  chipsForTable,
  generateStarterChips,
  probeDistinctCounts,
  isCategoryEligible,
  CATEGORY_DISTINCT_ROW_FRACTION,
  type TableDistinct,
} from "./starter-questions";
import {
  ASK_MAX_STARTER_CHIPS_PER_TABLE,
  ASK_CATEGORY_DISTINCT_MAX,
  type QueryableTable,
} from "./types";
import type { DuckDBService } from "../types";

const monsters: QueryableTable = {
  tableName: "monsters",
  columns: [
    { name: "name", type: "string" },
    { name: "species", type: "string" },
    { name: "power", type: "number" },
  ],
};

/** Convenience: a probe with a single eligible column over `rows` rows. */
function probe(rowCount: number, columns: { column: string; distinct: number }[]): TableDistinct {
  return { rowCount, columns };
}

describe("isCategoryEligible", () => {
  it("accepts a small categorical column well under the row-fraction gate", () => {
    expect(isCategoryEligible(4, 14)).toBe(true);
  });

  it("rejects a near-unique column (distinct > 70% of rows)", () => {
    // 12 distinct of 14 rows ≈ 86% — the Monster_Name case.
    expect(isCategoryEligible(12, 14)).toBe(false);
  });

  it("rejects a constant column (distinct < 2)", () => {
    expect(isCategoryEligible(1, 100)).toBe(false);
  });

  it("rejects when distinct exceeds ASK_CATEGORY_DISTINCT_MAX", () => {
    expect(isCategoryEligible(ASK_CATEGORY_DISTINCT_MAX + 1, 1000)).toBe(false);
  });

  it("uses exactly the 70% boundary", () => {
    const rows = 10;
    const boundary = CATEGORY_DISTINCT_ROW_FRACTION * rows; // 7
    expect(isCategoryEligible(boundary, rows)).toBe(true);
    expect(isCategoryEligible(boundary + 1, rows)).toBe(false);
  });
});

describe("chipsForTable", () => {
  it("always emits a row-count chip", () => {
    const chips = chipsForTable({ tableName: "t", columns: [] }, null);
    expect(chips).toHaveLength(1);
    expect(chips[0].sql).toBe('SELECT COUNT(*) AS row_count FROM "t"');
    expect(chips[0].chart).toBeUndefined();
  });

  it("emits a rows-per-category chip with a bar chart for an eligible column", () => {
    const chips = chipsForTable(monsters, probe(20, [
      { column: "name", distinct: 19 }, // near-unique → excluded
      { column: "species", distinct: 4 }, // eligible
    ]));
    const cat = chips.filter((c) => c.chart);
    expect(cat).toHaveLength(1);
    expect(cat[0].question).toContain("species");
    expect(cat[0].sql).toContain('GROUP BY "species"');
    expect(cat[0].chart).toEqual({ type: "bar", x: "category", y: "count" });
  });

  it("excludes a near-unique string column (Monster_Name-style)", () => {
    const chips = chipsForTable(
      { tableName: "monsters", columns: [{ name: "Monster_Name", type: "string" }] },
      probe(14, [{ column: "Monster_Name", distinct: 12 }])
    );
    expect(chips.some((c) => c.chart)).toBe(false);
  });

  it("offers up to TWO category chips in schema order, capped at the per-table max", () => {
    // Two eligible string columns + no numeric: row-count + 2 category chips = 3.
    const twoCat: QueryableTable = {
      tableName: "monsters",
      columns: [
        { name: "Monster_Name", type: "string" },
        { name: "Species", type: "string" },
        { name: "Threat_Level", type: "string" },
      ],
    };
    const chips = chipsForTable(twoCat, probe(14, [
      { column: "Monster_Name", distinct: 12 }, // near-unique → excluded
      { column: "Species", distinct: 5 }, // eligible
      { column: "Threat_Level", distinct: 3 }, // eligible
    ]));
    const cats = chips.filter((c) => c.chart);
    expect(cats.map((c) => c.question)).toEqual([
      "How many rows per Species in monsters?",
      "How many rows per Threat_Level in monsters?",
    ]);
    expect(chips.length).toBeLessThanOrEqual(ASK_MAX_STARTER_CHIPS_PER_TABLE);
  });

  it("emits top-10 and min/max/avg chips for a numeric column", () => {
    const chips = chipsForTable(monsters, probe(20, [{ column: "species", distinct: 4 }]));
    expect(chips.some((c) => /ORDER BY "power" DESC LIMIT 10/.test(c.sql))).toBe(true);
    expect(chips.some((c) => /MIN\("power"\).*AVG\("power"\)/.test(c.sql))).toBe(true);
  });

  it("emits only the row-count chip when there are no string or numeric columns", () => {
    const boolOnly: QueryableTable = {
      tableName: "flags",
      columns: [{ name: "ok", type: "boolean" }],
    };
    const chips = chipsForTable(boolOnly, null);
    expect(chips).toHaveLength(1);
  });

  it("caps at ASK_MAX_STARTER_CHIPS_PER_TABLE", () => {
    const chips = chipsForTable(monsters, probe(20, [{ column: "species", distinct: 4 }]));
    expect(chips.length).toBeLessThanOrEqual(ASK_MAX_STARTER_CHIPS_PER_TABLE);
  });

  it("is deterministic for the same schema and probe", () => {
    const p = probe(20, [{ column: "species", distinct: 4 }]);
    expect(chipsForTable(monsters, p)).toEqual(chipsForTable(monsters, p));
  });

  it("escapes identifiers in generated SQL", () => {
    const hostile: QueryableTable = {
      tableName: 'ev"il',
      columns: [{ name: "a", type: "number" }],
    };
    const chips = chipsForTable(hostile, null);
    expect(chips[0].sql).toContain('"ev""il"');
  });
});

/**
 * A fake DuckDBService that answers the per-table probe. It reads the aliases
 * `n` (row count) and `d0..dN` (distinct per string column) the probe selects,
 * driven by a table → { rows, distincts[] } map keyed by schema order.
 */
function fakeDb(
  byTable: Record<string, { rows: number; distincts: number[] }>
): DuckDBService {
  return {
    init: async () => {},
    createTable: async () => {
      throw new Error("unused");
    },
    getRowCount: async () => 0,
    getPreviewRows: async () => [],
    query: (async (sql: string) => {
      const match = /FROM\s+"([^"]+)"/.exec(sql);
      const table = match?.[1] ?? "";
      const entry = byTable[table] ?? { rows: 0, distincts: [] };
      const row: Record<string, number> = { n: entry.rows };
      entry.distincts.forEach((d, i) => {
        row[`d${i}`] = d;
      });
      return [row];
    }) as DuckDBService["query"],
  };
}

describe("probeDistinctCounts / generateStarterChips", () => {
  it("probes every string column with the row count", async () => {
    const db = fakeDb({ monsters: { rows: 14, distincts: [12, 4] } });
    const probes = await probeDistinctCounts(db, [monsters]);
    expect(probes.get("monsters")).toEqual({
      rowCount: 14,
      columns: [
        { column: "name", distinct: 12 },
        { column: "species", distinct: 4 },
      ],
    });
  });

  it("returns an empty-columns probe for a table with no string column", async () => {
    const db = fakeDb({ nums: { rows: 5, distincts: [] } });
    const numeric: QueryableTable = {
      tableName: "nums",
      columns: [{ name: "x", type: "number" }],
    };
    const probes = await probeDistinctCounts(db, [numeric]);
    expect(probes.get("nums")).toEqual({ rowCount: 0, columns: [] });
  });

  it("behaves as intended on demo-like monsters data", async () => {
    // Monster_Name near-unique (12/14), Species & Threat_Level eligible.
    const demoMonsters: QueryableTable = {
      tableName: "monsters",
      columns: [
        { name: "Monster_Name", type: "string" },
        { name: "Species", type: "string" },
        { name: "Threat_Level", type: "string" },
        { name: "Power", type: "number" },
      ],
    };
    const db = fakeDb({ monsters: { rows: 14, distincts: [12, 5, 3] } });
    const chips = await generateStarterChips(db, [demoMonsters]);
    const categoryQuestions = chips.filter((c) => c.chart).map((c) => c.question);
    expect(categoryQuestions).toEqual([
      "How many rows per Species in monsters?",
      "How many rows per Threat_Level in monsters?",
    ]);
    // Monster_Name must NOT produce a category chip.
    expect(categoryQuestions.some((q) => q.includes("Monster_Name"))).toBe(false);
    // Per-table cap still honored.
    expect(chips.length).toBeLessThanOrEqual(ASK_MAX_STARTER_CHIPS_PER_TABLE);
  });

  it("generates chips for every table and never throws on a probe error", async () => {
    const throwingDb: DuckDBService = {
      ...fakeDb({}),
      query: (async () => {
        throw new Error("probe failed");
      }) as DuckDBService["query"],
    };
    const chips = await generateStarterChips(throwingDb, [monsters]);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => c.tableName === "monsters")).toBe(true);
    expect(chips.some((c) => c.chart)).toBe(false);
  });
});
