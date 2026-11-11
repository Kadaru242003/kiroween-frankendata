/**
 * Unit tests for the deterministic cleaning rules (Feature 2, task 7).
 *
 * Covers the design's "Cleaning rules" section and Requirements 2.1–2.8:
 *   - whitespace: trim + collapse only, never case;
 *   - case: offered only for differing-casing values → most-frequent form;
 *   - category-standardize: folding + equal-folded clustering + near-dup merge,
 *     canonical = most-frequent surface form (ties lexicographic), variantMap;
 *   - every proposal carries before/after + a one-line reason;
 *   - idempotence by construction (re-cleaning cleaned values is a no-op).
 *
 * The duplicate-rows and outlier proposals (full-column SQL counts) are covered
 * by the DuckDB-backed test in `cleaning-rules.duckdb.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import type { ColumnType, DuckDBService } from "../types";
import {
  CATEGORY_MERGE_SIMILARITY,
  cleanTables,
  clusterCategories,
  foldCategory,
  normalizeWhitespace,
  normalizedLevenshtein,
  type NonNullSample,
} from "./cleaning-rules";
import type { CleaningProposal, SampleValue, TableSample } from "./types";

/** A DuckDBService stub whose COUNTs report zero (no duplicates/outliers). */
function zeroDb(): DuckDBService {
  return {
    init: vi.fn(async () => {}),
    createTable: vi.fn(),
    getRowCount: vi.fn(async () => 0),
    getPreviewRows: vi.fn(async () => []),
    query: vi.fn(async () => [{ total: 0, dups: 0, non_null: 0, outliers: 0 }]),
  } as unknown as DuckDBService;
}

function sv(entries: [string, number][]): NonNullSample[] {
  return entries.map(([value, count]) => ({ value, count }));
}

function table(
  tableName: string,
  columns: Record<string, { type: ColumnType; samples: SampleValue[] }>
): TableSample {
  const schema = Object.entries(columns).map(([name, { type }]) => ({
    name,
    type,
  }));
  const samplesByColumn: Record<string, SampleValue[]> = {};
  for (const [name, { samples }] of Object.entries(columns)) {
    samplesByColumn[name] = samples;
  }
  return { tableName, rowCount: 0, schema, samplesByColumn };
}

function byKind(
  proposals: CleaningProposal[],
  kind: CleaningProposal["kind"],
  idPrefix?: string
): CleaningProposal[] {
  return proposals.filter(
    (p) => p.kind === kind && (idPrefix ? p.id.startsWith(idPrefix) : true)
  );
}

describe("pure helpers", () => {
  it("normalizeWhitespace trims and collapses, never changing case", () => {
    expect(normalizeWhitespace("  Swamp   Wraith  ")).toBe("Swamp Wraith");
    expect(normalizeWhitespace("iPhone")).toBe("iPhone");
    // idempotent
    expect(normalizeWhitespace(normalizeWhitespace(" a  b "))).toBe("a b");
  });

  it("foldCategory lowercases, collapses whitespace, and folds punctuation", () => {
    expect(foldCategory("Swamp Wraith")).toBe("swamp wraith");
    expect(foldCategory("swamp-wraith")).toBe("swamp wraith");
    expect(foldCategory("swamp  wraith")).toBe("swamp wraith");
    expect(foldCategory("SWAMP_WRAITH")).toBe("swamp wraith");
    // idempotent on its own output
    expect(foldCategory(foldCategory("Swamp-Wraith"))).toBe("swamp wraith");
  });

  it("normalizedLevenshtein scores a single-substitution typo on a long value ≥ the merge threshold", () => {
    // One substitution in a 12-char folded value: 1 − 1/12 ≈ 0.917 ≥ 0.9.
    expect(
      normalizedLevenshtein("swamp wraith", "swamp wreith")
    ).toBeGreaterThanOrEqual(CATEGORY_MERGE_SIMILARITY);
    // A two-edit transposition on a short value stays below the threshold
    // (standard Levenshtein counts a swap as two edits).
    expect(normalizedLevenshtein("wraith", "wriath")).toBeLessThan(
      CATEGORY_MERGE_SIMILARITY
    );
    expect(normalizedLevenshtein("abc", "")).toBe(0);
    expect(normalizedLevenshtein("", "")).toBe(1);
  });
});

describe("whitespace proposal (Req 2.1)", () => {
  it("proposes trim+collapse when a value has stray whitespace, never touching case", async () => {
    const tables = [
      table("t", {
        label: {
          type: "string",
          samples: sv([
            ["  ghoul  ", 2],
            ["swamp  wraith", 1],
          ]),
        },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    const ws = byKind(proposals, "whitespace-case", "clean:whitespace:");
    expect(ws).toHaveLength(1);
    expect(normalizeWhitespace(String(ws[0].before))).toBe(ws[0].after);
    expect(ws[0].reason).toMatch(/whitespace/i);
    expect(ws[0].reason).not.toContain("\n");
  });

  it("does not propose whitespace when every value is already normalized", async () => {
    const tables = [
      table("t", {
        label: { type: "string", samples: sv([["ghoul", 2], ["wraith", 1]]) },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    expect(byKind(proposals, "whitespace-case", "clean:whitespace:")).toEqual(
      []
    );
  });
});

describe("case proposal (Req 2.1)", () => {
  it("offers a case fix only when the same value appears in differing casings", async () => {
    const tables = [
      table("t", {
        kind: {
          type: "string",
          samples: sv([
            ["swamp wraith", 5], // most frequent surface form
            ["Swamp Wraith", 2],
            ["ogre", 1], // unique casing → untouched
          ]),
        },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    const cases = byKind(proposals, "whitespace-case", "clean:case:");
    expect(cases).toHaveLength(1);
    // canonical = most frequent surface form.
    expect(cases[0].canonical).toBe("swamp wraith");
    expect(cases[0].variantMap).toEqual({ "Swamp Wraith": "swamp wraith" });
    // "ogre" (unique casing) is not in the variant map.
    expect(cases[0].variantMap).not.toHaveProperty("ogre");
  });

  it("breaks most-frequent ties by the lexicographically smallest form", async () => {
    const tables = [
      table("t", {
        kind: {
          type: "string",
          samples: sv([
            ["Wraith", 3],
            ["wraith", 3], // tie at 3 → smallest ("Wraith" < "wraith" by code point)
          ]),
        },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    const cases = byKind(proposals, "whitespace-case", "clean:case:");
    expect(cases[0].canonical).toBe("Wraith");
    expect(cases[0].variantMap).toEqual({ wraith: "Wraith" });
  });

  it("offers no case fix when every value has a unique casing", async () => {
    const tables = [
      table("t", {
        kind: { type: "string", samples: sv([["ghoul", 2], ["Wraith", 1]]) },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    expect(byKind(proposals, "whitespace-case", "clean:case:")).toEqual([]);
  });
});

describe("category-standardize (Req 2.2)", () => {
  it("clusters by equal folded form and merges single-substitution typos", () => {
    const clusters = clusterCategories(
      sv([
        ["Swamp Wraith", 5],
        ["swamp-wraith", 2],
        ["swamp  wraith", 1],
        ["swamp wreith", 1], // one-substitution typo → merged via ≥0.9 similarity
        ["Ogre", 3],
      ])
    );
    // swamp* all collapse into one cluster; Ogre is its own.
    const swampCluster = clusters.find((c) =>
      c.members.some((m) => m.value === "Swamp Wraith")
    );
    expect(swampCluster).toBeDefined();
    const forms = new Set(swampCluster!.members.map((m) => m.value));
    expect(forms).toEqual(
      new Set(["Swamp Wraith", "swamp-wraith", "swamp  wraith", "swamp wreith"])
    );
    expect(clusters.some((c) => c.members.some((m) => m.value === "Ogre"))).toBe(
      true
    );
  });

  it("picks the canonical as the most frequent surface form and builds variantMap", async () => {
    const tables = [
      table("t", {
        creature: {
          type: "string",
          samples: sv([
            ["Swamp Wraith", 5], // most frequent → canonical
            ["swamp-wraith", 2],
            ["swamp wraith", 1],
          ]),
        },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    const cat = byKind(proposals, "category-standardize")[0];
    expect(cat).toBeDefined();
    expect(cat.canonical).toBe("Swamp Wraith");
    expect(cat.variantMap).toEqual({
      "Swamp Wraith": "Swamp Wraith",
      "swamp wraith": "Swamp Wraith",
      "swamp-wraith": "Swamp Wraith",
    });
    expect(cat.reason).not.toContain("\n");
  });

  it("does not propose standardization when all values fold distinctly", async () => {
    const tables = [
      table("t", {
        creature: {
          type: "string",
          samples: sv([["ghoul", 3], ["wraith", 2], ["ogre", 1]]),
        },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    expect(byKind(proposals, "category-standardize")).toEqual([]);
  });

  it("is deterministic and order-independent across sample input order", async () => {
    const samples = sv([
      ["swamp-wraith", 2],
      ["Swamp Wraith", 5],
      ["swamp wriath", 1],
      ["swamp wraith", 1],
    ]);
    const first = await cleanTables(zeroDb(), [
      table("t", { creature: { type: "string", samples } }),
    ]);
    const reversed = await cleanTables(zeroDb(), [
      table("t", { creature: { type: "string", samples: [...samples].reverse() } }),
    ]);
    const a = byKind(first, "category-standardize")[0];
    const b = byKind(reversed, "category-standardize")[0];
    expect(a.canonical).toBe(b.canonical);
    expect(a.variantMap).toEqual(b.variantMap);
  });
});

describe("idempotence sanity (Req 2.8)", () => {
  it("applying the proposed canonical maps are no-ops on re-application", async () => {
    const tables = [
      table("t", {
        creature: {
          type: "string",
          samples: sv([
            ["Swamp Wraith", 5],
            ["swamp-wraith", 2],
          ]),
        },
      }),
    ];
    const proposals = await cleanTables(zeroDb(), tables);
    const cat = byKind(proposals, "category-standardize")[0];
    const map = cat.variantMap!;
    // Every canonical maps to itself, and applying the map twice equals once.
    for (const [variant, canonical] of Object.entries(map)) {
      expect(map[canonical]).toBe(canonical); // canonical is a fixed point
      const once = map[variant] ?? variant;
      const twice = map[once] ?? once;
      expect(twice).toBe(once);
    }
    // Whitespace + fold are idempotent on their own outputs too.
    expect(normalizeWhitespace(cat.canonical as string)).toBe(cat.canonical);
    expect(foldCategory(foldCategory(cat.canonical as string))).toBe(
      foldCategory(cat.canonical as string)
    );
  });
});
