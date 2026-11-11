/**
 * Unit tests for deterministic match scoring (Feature 2, task 6).
 *
 * Covers the design's "Hard gates", "valueOverlap damping", "Type compatibility
 * matrix", and "Final confidence" sections, and Requirements 1.1–1.6, 5.2, 5.3:
 *   - typeCompat matrix lookups, incl. the hard-zero entries;
 *   - valueOverlap overlap-coefficient + small-set damping;
 *   - the three hard gates (type-incompatible, boolean on either side, name floor);
 *   - confidence weighting and [0, 1] bounds;
 *   - matchTables symmetry, dedup, and the >= MATCH_DISPLAY_THRESHOLD exposure.
 */

import { describe, expect, it } from "vitest";
import type { ColumnSchema, ColumnType } from "../types";
import {
  NAME_SIM_FLOOR,
  confidence,
  isHardGated,
  matchTables,
  normalizeSampleValue,
  typeCompat,
  valueOverlap,
} from "./match-scoring";
import {
  MATCH_DISPLAY_THRESHOLD,
  type SampleValue,
  type TableSample,
} from "./types";

const ALL_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/** Build sample values (all frequency 1) from plain strings. */
function samples(values: string[]): SampleValue[] {
  return values.map((value) => ({ value, count: 1 }));
}

/** Build a TableSample from a name and a map of column → sample strings. */
function table(
  tableName: string,
  columns: Record<string, { type: ColumnType; values: string[] }>
): TableSample {
  const schema: ColumnSchema[] = Object.entries(columns).map(
    ([name, { type }]) => ({ name, type })
  );
  const samplesByColumn: Record<string, SampleValue[]> = {};
  for (const [name, { values }] of Object.entries(columns)) {
    samplesByColumn[name] = samples(values);
  }
  return { tableName, rowCount: 0, schema, samplesByColumn };
}

describe("typeCompat", () => {
  it("returns 1.0 for identical types (the matrix diagonal)", () => {
    for (const type of ALL_TYPES) {
      expect(typeCompat(type, type)).toBe(1.0);
    }
  });

  it("treats string as a weak (0.3) bridge to every non-string type", () => {
    expect(typeCompat("string", "number")).toBe(0.3);
    expect(typeCompat("string", "boolean")).toBe(0.3);
    expect(typeCompat("string", "date")).toBe(0.3);
    expect(typeCompat("number", "string")).toBe(0.3);
    expect(typeCompat("boolean", "string")).toBe(0.3);
    expect(typeCompat("date", "string")).toBe(0.3);
  });

  it("is a hard-zero for every incompatible non-string pairing", () => {
    expect(typeCompat("number", "boolean")).toBe(0.0);
    expect(typeCompat("number", "date")).toBe(0.0);
    expect(typeCompat("boolean", "number")).toBe(0.0);
    expect(typeCompat("boolean", "date")).toBe(0.0);
    expect(typeCompat("date", "number")).toBe(0.0);
    expect(typeCompat("date", "boolean")).toBe(0.0);
  });

  it("is symmetric for every type pairing", () => {
    for (const a of ALL_TYPES) {
      for (const b of ALL_TYPES) {
        expect(typeCompat(a, b)).toBe(typeCompat(b, a));
      }
    }
  });
});

describe("normalizeSampleValue", () => {
  it("trims, collapses internal whitespace, and lowercases", () => {
    expect(normalizeSampleValue("  Swamp   Wraith  ")).toBe("swamp wraith");
    expect(normalizeSampleValue("SWAMP\tWRAITH")).toBe("swamp wraith");
  });

  it("is idempotent", () => {
    const once = normalizeSampleValue("  Night  Howler ");
    expect(normalizeSampleValue(once)).toBe(once);
  });
});

describe("valueOverlap", () => {
  it("is 0 when either sample set is empty", () => {
    expect(valueOverlap([], samples(["a", "b"]))).toBe(0);
    expect(valueOverlap(samples(["a", "b"]), [])).toBe(0);
  });

  it("uses the overlap coefficient (min denominator) with full-weight large sets", () => {
    // Smaller set of 10 fully contained in the larger set → raw = 1, damping = 1.
    const small = samples(Array.from({ length: 10 }, (_, i) => `v${i}`));
    const large = samples(Array.from({ length: 50 }, (_, i) => `v${i}`));
    expect(valueOverlap(small, large)).toBe(1);
  });

  it("damps small distinct sets so they cannot score full value overlap", () => {
    // Two identical 2-value sets: raw overlap 1.0, but damping = 2/10 = 0.2.
    const a = samples(["yes", "no"]);
    const b = samples(["yes", "no"]);
    expect(valueOverlap(a, b)).toBeCloseTo(0.2, 10);
  });

  it("scales damping linearly up to the full-size threshold", () => {
    // 5 shared of 5 on the smaller side: raw 1.0, damping 5/10 = 0.5.
    const a = samples(["a", "b", "c", "d", "e"]);
    const b = samples(["a", "b", "c", "d", "e", "f", "g"]);
    expect(valueOverlap(a, b)).toBeCloseTo(0.5, 10);
  });

  it("normalizes values (trim/case/whitespace) before comparing", () => {
    const a = samples(["  Swamp Wraith ", "NIGHT HOWLER", "bog beast"]);
    const b = samples(["swamp   wraith", "night howler", "unrelated"]);
    // Two of three (smaller side has 3) match after normalization: raw 2/3,
    // damping 3/10. 2/3 * 0.3 = 0.2.
    expect(valueOverlap(a, b)).toBeCloseTo(0.2, 10);
  });

  it("is symmetric", () => {
    const a = samples(["a", "b", "c", "x"]);
    const b = samples(["a", "b", "c", "y", "z"]);
    expect(valueOverlap(a, b)).toBe(valueOverlap(b, a));
  });
});

describe("isHardGated", () => {
  it("gates type-incompatible pairs (matrix hard-zero)", () => {
    expect(isHardGated("number", "date", 1)).toBe(true);
    expect(isHardGated("date", "number", 1)).toBe(true);
  });

  it("gates any pair where either column is boolean", () => {
    expect(isHardGated("boolean", "boolean", 1)).toBe(true);
    // string<->boolean is matrix-compatible (0.3) but still gated by the
    // boolean exclusion.
    expect(isHardGated("boolean", "string", 1)).toBe(true);
    expect(isHardGated("string", "boolean", 1)).toBe(true);
  });

  it("gates names below the similarity floor", () => {
    expect(isHardGated("string", "string", NAME_SIM_FLOOR - 0.01)).toBe(true);
    expect(isHardGated("string", "string", NAME_SIM_FLOOR)).toBe(false);
  });

  it("passes a compatible, well-named, non-boolean pair", () => {
    expect(isHardGated("string", "string", 0.9)).toBe(false);
    expect(isHardGated("number", "string", 0.5)).toBe(false);
  });

  it("is symmetric in its type arguments", () => {
    for (const a of ALL_TYPES) {
      for (const b of ALL_TYPES) {
        expect(isHardGated(a, b, 0.5)).toBe(isHardGated(b, a, 0.5));
      }
    }
  });
});

describe("confidence", () => {
  it("applies the 0.50/0.20/0.30 weighting", () => {
    expect(
      confidence({ nameSim: 1, typeCompat: 1, valueOverlap: 1 })
    ).toBeCloseTo(1, 10);
    expect(
      confidence({ nameSim: 0, typeCompat: 0, valueOverlap: 0 })
    ).toBeCloseTo(0, 10);
    expect(
      confidence({ nameSim: 1, typeCompat: 0, valueOverlap: 0 })
    ).toBeCloseTo(0.5, 10);
    expect(
      confidence({ nameSim: 0, typeCompat: 1, valueOverlap: 0 })
    ).toBeCloseTo(0.2, 10);
    expect(
      confidence({ nameSim: 0, typeCompat: 0, valueOverlap: 1 })
    ).toBeCloseTo(0.3, 10);
  });

  it("stays within [0, 1]", () => {
    const score = confidence({ nameSim: 0.7, typeCompat: 0.3, valueOverlap: 0.4 });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("matchTables", () => {
  it("proposes a strong name+value match across tables", () => {
    const monsters = table("monsters", {
      "Monster Name": {
        type: "string",
        values: ["Swamp Wraith", "Night Howler", "Bog Beast", "Ash Golem"],
      },
    });
    const experiments = table("experiments", {
      name: {
        type: "string",
        values: ["Swamp Wraith", "Night Howler", "Bog Beast", "Ash Golem"],
      },
    });
    const result = matchTables([monsters, experiments]);
    expect(result).toHaveLength(1);
    const match = result[0];
    expect(match.left.columnName === "Monster Name" ||
      match.right.columnName === "Monster Name").toBe(true);
    expect(match.confidence).toBeGreaterThanOrEqual(MATCH_DISPLAY_THRESHOLD);
    expect(match.source).toBe("rules");
    expect(match.components.nameSim).toBeGreaterThan(0);
    expect(match.reason).toContain("name");
  });

  it("excludes boolean columns even when names and values align (sedated vs hazardous style)", () => {
    const a = table("monsters", {
      sedated: { type: "boolean", values: ["true", "false"] },
    });
    const b = table("experiments", {
      sedated: { type: "boolean", values: ["true", "false"] },
    });
    expect(matchTables([a, b])).toHaveLength(0);
  });

  it("does not match type-incompatible columns", () => {
    const a = table("a", {
      count: { type: "number", values: ["1", "2", "3"] },
    });
    const b = table("b", {
      count: { type: "date", values: ["1", "2", "3"] },
    });
    expect(matchTables([a, b])).toHaveLength(0);
  });

  it("filters out pairs below the display threshold by default", () => {
    // Unrelated names, no shared values → confidence well under threshold.
    const a = table("a", {
      alpha: { type: "string", values: ["x", "y", "z"] },
    });
    const b = table("b", {
      omega: { type: "string", values: ["p", "q", "r"] },
    });
    expect(matchTables([a, b])).toHaveLength(0);
  });

  it("retains the full scored set when displayOnly is false", () => {
    const a = table("a", {
      widget: { type: "string", values: ["x"] },
    });
    const b = table("b", {
      gadget: { type: "string", values: ["y"] },
    });
    const full = matchTables([a, b], false);
    const displayed = matchTables([a, b], true);
    // The gadget/widget pair survives the gates (shared "get" token keeps
    // nameSim above the floor) but scores below the threshold.
    expect(full.length).toBeGreaterThan(displayed.length);
    for (const match of full) {
      expect(match.confidence).toBeGreaterThanOrEqual(0);
      expect(match.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("produces symmetric scores regardless of table order", () => {
    const monsters = table("monsters", {
      name: { type: "string", values: ["a", "b", "c", "d", "e"] },
    });
    const experiments = table("experiments", {
      name: { type: "string", values: ["a", "b", "c", "d", "e"] },
    });
    const forward = matchTables([monsters, experiments]);
    const backward = matchTables([experiments, monsters]);
    expect(forward).toHaveLength(1);
    expect(backward).toHaveLength(1);
    expect(forward[0].id).toBe(backward[0].id);
    expect(forward[0].confidence).toBeCloseTo(backward[0].confidence, 12);
  });

  it("deduplicates symmetric pairs to a single proposal", () => {
    const a = table("alpha", {
      name: { type: "string", values: ["a", "b", "c", "d"] },
    });
    const b = table("beta", {
      name: { type: "string", values: ["a", "b", "c", "d"] },
    });
    const result = matchTables([a, b]);
    const ids = new Set(result.map((m) => m.id));
    expect(ids.size).toBe(result.length);
    expect(result).toHaveLength(1);
  });

  it("is deterministic: repeated runs give identical output", () => {
    const a = table("a", {
      name: { type: "string", values: ["a", "b", "c", "d"] },
      code: { type: "string", values: ["x1", "x2", "x3", "x4"] },
    });
    const b = table("b", {
      name: { type: "string", values: ["a", "b", "c", "d"] },
      code: { type: "string", values: ["x1", "x2", "x3", "x4"] },
    });
    const first = matchTables([a, b]);
    const second = matchTables([a, b]);
    expect(first).toEqual(second);
  });
});
