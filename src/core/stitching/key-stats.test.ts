import { describe, expect, it } from "vitest";
import {
  KEY_RATIO_FLOOR,
  chooseDefaultMatch,
  columnKeyStats,
  computeColumnKeyStats,
  manySideOf,
  statsKey,
} from "./key-stats";
import { defaultAnchorForKeys, defaultJoinKeysByPair, pairKey } from "./plan-assembly";
import { valueOverlap } from "./match-scoring";
import type { CleaningProposal, ColumnKeyStats, MatchProposal, TableSample } from "./types";

function sample(tableName: string, rowCount: number, columns: Record<string, Array<[string, number]>>): TableSample {
  return {
    tableName,
    rowCount,
    schema: Object.keys(columns).map((name) => ({ name, type: "string" as const })),
    samplesByColumn: Object.fromEntries(
      Object.entries(columns).map(([name, vals]) => [name, vals.map(([value, count]) => ({ value, count }))])
    ),
  };
}

function match(id: string, l: [string, string], r: [string, string], confidence: number): MatchProposal {
  return {
    id,
    left: { tableName: l[0], columnName: l[1], type: "string" },
    right: { tableName: r[0], columnName: r[1], type: "string" },
    confidence,
    reason: "",
    source: "rules",
    components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
  };
}

function stat(distinctRatio: number): ColumnKeyStats {
  return { nonNull: 100, distinct: Math.round(distinctRatio * 100), distinctRatio };
}

describe("value overlap compares normalized values (display values untouched)", () => {
  it("treats case, outer spaces and inner runs of spaces as the same value", () => {
    const left = [
      { value: "INFO@eastgate.example", count: 1 },
      { value: " orders@acme-supplies.example ", count: 2 },
      { value: "Sales@Brightline.Example", count: 1 },
    ];
    const right = [
      { value: "info@eastgate.example", count: 1 },
      { value: "orders@acme-supplies.example", count: 1 },
      { value: "sales@brightline.example", count: 1 },
    ];
    const snapshot = JSON.stringify([left, right]);
    // 3 of 3 shared, times the small-set damping min(1, 3 / 10).
    expect(valueOverlap(left, right)).toBeCloseTo(0.3, 10);
    expect(JSON.stringify([left, right])).toBe(snapshot);
    expect(valueOverlap([{ value: "a   b", count: 1 }], [{ value: "A B", count: 1 }])).toBeCloseTo(0.1, 10);
  });
});

describe("columnKeyStats", () => {
  it("counts distinct normalized non-null values", () => {
    const s = sample("t", 5, { email: [["INFO@x.example", 1], ["info@x.example ", 1], ["a@x.example", 3]] });
    expect(columnKeyStats(s, "email")).toEqual({ nonNull: 5, distinct: 2, distinctRatio: 0.4 });
  });

  it("scales the cell count by a proposed duplicate-row cleanup", () => {
    const s = sample("vendors", 6, { email: [["orders@x", 2], ["a@x", 1], ["b@x", 1], ["c@x", 1], ["d@x", 1]] });
    expect(columnKeyStats(s, "email").distinctRatio).toBeCloseTo(5 / 6, 10);
    expect(columnKeyStats(s, "email", 5 / 6).distinctRatio).toBe(1);
  });

  it("uses the exact totals when the sample list was cut", () => {
    const entries: Array<[string, number]> = Array.from({ length: 200 }, (_, i) => [`v${i}`, 1]);
    const s = sample("t", 1000, { id: entries });
    s.columnTotals = { id: { nonNull: 1000, rawDistinct: 1000 } };
    expect(columnKeyStats(s, "id")).toEqual({ nonNull: 1000, distinct: 1000, distinctRatio: 1 });
  });

  it("reads a duplicate-rows proposal into the stats of every column of that table", () => {
    const s = sample("vendors", 6, { email: [["orders@x", 2], ["a@x", 4]] });
    const dup: CleaningProposal = {
      id: "clean:duplicate-rows:vendors",
      target: { tableName: "vendors" },
      kind: "duplicate-rows",
      before: { rowCount: 6 },
      after: { rowCount: 3 },
      reason: "",
    };
    expect(computeColumnKeyStats([s], [dup])[statsKey("vendors", "email")].nonNull).toBe(3);
    expect(computeColumnKeyStats([s], [])[statsKey("vendors", "email")].nonNull).toBe(6);
  });
});

describe("chooseDefaultMatch", () => {
  const stats = {
    [statsKey("p", "country")]: stat(0.6),
    [statsKey("v", "country")]: stat(0.8),
    [statsKey("p", "email")]: stat(0.8),
    [statsKey("v", "email")]: stat(1),
    [statsKey("p", "fk")]: stat(0.1),
    [statsKey("v", "pk")]: stat(1),
    [statsKey("p", "flag")]: stat(0.01),
    [statsKey("v", "flag")]: stat(0.02),
  };
  const country = match("c", ["p", "country"], ["v", "country"], 0.79);
  const email = match("e", ["p", "email"], ["v", "email"], 0.55);

  it("prefers a key that is unique on a side over a more confident low-cardinality column", () => {
    expect(chooseDefaultMatch([country, email], stats)?.id).toBe("e");
  });

  it("keeps the old behavior (highest confidence) without stats", () => {
    expect(chooseDefaultMatch([country, email], undefined)?.id).toBe("c");
  });

  it("does not demote a foreign key whose own side repeats a lot (many-to-one)", () => {
    const fk = match("fk", ["p", "fk"], ["v", "pk"], 0.6);
    const flag = match("flag", ["p", "flag"], ["v", "flag"], 0.9);
    expect(chooseDefaultMatch([flag, fk], stats)?.id).toBe("fk");
  });

  it("uses a pair where neither side is half distinct only when nothing else exists", () => {
    const flag = match("flag", ["p", "flag"], ["v", "flag"], 0.9);
    expect(chooseDefaultMatch([flag], stats)?.id).toBe("flag");
    const other = match("o", ["p", "country"], ["v", "country"], 0.5);
    expect(chooseDefaultMatch([flag, other], stats)?.id).toBe("o");
    expect(KEY_RATIO_FLOOR).toBe(0.5);
  });

  it("breaks a tie on id", () => {
    const a = match("a", ["p", "email"], ["v", "email"], 0.7);
    const b = match("b", ["p", "email"], ["v", "email"], 0.7);
    expect(chooseDefaultMatch([b, a], stats)?.id).toBe("a");
  });

  it("switches to a more key-like candidate of similar confidence", () => {
    const st = { [statsKey("p", "x")]: stat(0.6), [statsKey("v", "x")]: stat(0.7), [statsKey("p", "y")]: stat(0.9), [statsKey("v", "y")]: stat(0.55) };
    const x = match("x", ["p", "x"], ["v", "x"], 0.9); // score .54, key ratio .7
    const y = match("y", ["p", "y"], ["v", "y"], 0.82); // score .451, key ratio .9
    expect(chooseDefaultMatch([x, y], st)?.id).toBe("y");
  });
});

describe("default anchor", () => {
  const tables = [
    { tableName: "purchases", rowCount: 5 },
    { tableName: "vendors", rowCount: 6 },
  ];
  const stats = {
    [statsKey("purchases", "email")]: stat(0.8),
    [statsKey("vendors", "email")]: stat(1),
  };
  const email = match("e", ["purchases", "email"], ["vendors", "email"], 0.55);

  it("is the side where the chosen key repeats", () => {
    expect(manySideOf(email, stats)).toBe("purchases");
    expect(defaultAnchorForKeys(tables, [email], stats)).toBe("purchases");
  });

  it("is the table with the most rows when the key does not tell the sides apart", () => {
    const both = { ...stats, [statsKey("purchases", "email")]: stat(1) };
    expect(manySideOf(email, both)).toBeUndefined();
    expect(defaultAnchorForKeys(tables, [email], both)).toBe("vendors");
    const neither = { ...stats, [statsKey("vendors", "email")]: stat(0.9) };
    expect(defaultAnchorForKeys(tables, [email], neither)).toBe("vendors");
    expect(defaultAnchorForKeys(tables, [email], undefined)).toBe("vendors");
  });

  it("defaultJoinKeysByPair maps each pair to its chosen match", () => {
    const country = match("c", ["purchases", "country"], ["vendors", "country"], 0.79);
    const st = { ...stats, [statsKey("purchases", "country")]: stat(0.6), [statsKey("vendors", "country")]: stat(0.8) };
    expect(defaultJoinKeysByPair([country, email], st)).toEqual({ [pairKey("purchases", "vendors")]: "e" });
    expect(defaultJoinKeysByPair([country, email])).toEqual({ [pairKey("purchases", "vendors")]: "c" });
  });
});
