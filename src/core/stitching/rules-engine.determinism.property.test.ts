/**
 * Property-based tests for rules-engine determinism.
 *
 * Feature: frankendata-ai-stitching, Property 11: Rules-engine determinism
 *
 * Validates: Requirements 5.2, 10.11
 *
 * Property 11 statement (design, "Correctness Properties"): *For any* input,
 * running the rules engine repeatedly on the same input yields identical
 * proposals and identical `ConfidenceScore`s.
 *
 * The design ("SampleReader query (determinism)", "Final confidence",
 * "RulesEngine") pins determinism as a concrete, testable contract:
 *   - identical input → bit-for-bit identical output on every run (idempotent
 *     repetition), and
 *   - the output must NOT depend on the incidental ordering of the input —
 *     the order columns appear within a table, or the order tables are passed —
 *     because the engine sorts deterministically (confidence desc, then stable
 *     pair id) and derives a stable, order-independent pair id and canonical
 *     left/right orientation. Reordering the input must therefore leave the
 *     proposal set, every `confidence`, every `components` breakdown, every
 *     `reason`, and the final ordering unchanged.
 *
 * This test exercises the *pure* match/scoring side of the engine — the
 * headline determinism concern of Property 11 — with no DuckDB and no network:
 * samples are supplied directly as {@link TableSample}s (what the SampleReader
 * would otherwise read from DuckDB). The cleaning side's SQL-backed counts
 * (duplicate-rows, outliers) are covered by their own DuckDB-backed tests
 * (`cleaning-rules.duckdb.test.ts`); here we additionally pin the determinism
 * of the engine's *pure* cleaning logic — whitespace/case/category clustering —
 * which needs no DuckDB, via the exported helpers.
 *
 * Functions under test:
 *   - {@link matchTables} / {@link createRulesEngine}'s `match` (task 6) — the
 *     engine entry point;
 *   - the component scorers {@link typeCompat}, {@link valueOverlap},
 *     {@link confidence} and {@link nameSim};
 *   - the pure cleaning helpers {@link clusterCategories},
 *     {@link foldCategory}, {@link normalizeWhitespace} (task 7).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ColumnSchema, ColumnType } from "../types";
import { nameSim } from "./name-similarity";
import {
  confidence,
  matchTables,
  typeCompat,
  valueOverlap,
  type MatchComponents,
} from "./match-scoring";
import { createRulesEngine } from "./rules-engine";
import {
  clusterCategories,
  foldCategory,
  normalizeWhitespace,
  type NonNullSample,
} from "./cleaning-rules";
import type { DuckDBService } from "../types";
import type { MatchProposal, SampleValue, TableSample } from "./types";

/** Property-test iteration count (design: fast-check, >= 100 iterations). */
const NUM_RUNS = 200;

const ALL_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Column names drawn from a small, deliberately overlapping vocabulary (mixing
 * case/separators) so generated tables frequently produce real, surviving
 * proposals while still exercising dissimilar pairs and name normalization.
 */
const columnName = fc.constantFrom(
  "name",
  "Monster Name",
  "monster_name",
  "monsterName",
  "lead_scientist",
  "scientist",
  "id",
  "experiment_id",
  "status",
  "sedated",
  "hazardous",
  "created_at",
  "date",
  "weight",
  "score",
);

/** A column type. */
const columnType: fc.Arbitrary<ColumnType> = fc.constantFrom(...ALL_TYPES);

/**
 * A single sampled value from a small shared vocabulary so distinct value sets
 * across tables genuinely overlap often (exercising `valueOverlap` rather than
 * always scoring 0). Mixed casing/whitespace also stresses sample normalization
 * and category folding.
 */
const sampleString = fc.constantFrom(
  "Swamp Wraith",
  "swamp-wraith",
  "  swamp   wraith ",
  "Bog Golem",
  "Night Howler",
  "true",
  "false",
  "42",
  "7",
  "2024-01-01",
  "alpha",
  "Alpha",
  "beta",
  "gamma",
);

/** A column's frequency-carrying samples (counts are arbitrary positive ints). */
const sampleValues: fc.Arbitrary<SampleValue[]> = fc.array(
  fc.record({
    value: sampleString as fc.Arbitrary<string | null>,
    count: fc.integer({ min: 1, max: 50 }),
  }),
  { maxLength: 15 },
);

/** One generated column: a (unique-within-table) name, a type, and its samples. */
interface GenColumn {
  name: string;
  type: ColumnType;
  samples: SampleValue[];
}

const genColumn: fc.Arbitrary<GenColumn> = fc.record({
  name: columnName,
  type: columnType,
  samples: sampleValues,
});

/** A generated table: a distinct-within-set name and 1..5 uniquely-named columns. */
const genTable: fc.Arbitrary<TableSample> = fc
  .tuple(
    fc.constantFrom("monsters", "experiments", "lab_log", "intake"),
    fc.uniqueArray(genColumn, {
      minLength: 1,
      maxLength: 5,
      selector: (col: GenColumn) => col.name,
    }),
  )
  .map(([tableName, columns]): TableSample => {
    const schema: ColumnSchema[] = columns.map((col) => ({
      name: col.name,
      type: col.type,
    }));
    const samplesByColumn: Record<string, SampleValue[]> = {};
    for (const col of columns) {
      samplesByColumn[col.name] = col.samples;
    }
    return { tableName, rowCount: 0, schema, samplesByColumn };
  });

/** 2..4 tables with DISTINCT table names (matching only happens cross-table). */
const distinctTables: fc.Arbitrary<TableSample[]> = fc.uniqueArray(genTable, {
  minLength: 2,
  maxLength: 4,
  selector: (t: TableSample) => t.tableName,
});

// ── Order-independence helpers ─────────────────────────────────────────────────

/**
 * Return a copy of `tables` with the column order within each table reversed
 * (schema and the `samplesByColumn` record are left referencing the same sample
 * arrays — only iteration order changes). The engine must be insensitive to
 * this: the pair id, canonical orientation, and sort are all order-independent.
 */
function reverseColumnOrder(tables: TableSample[]): TableSample[] {
  return tables.map((t) => {
    const reversedSchema = [...t.schema].reverse();
    const reorderedSamples: Record<string, SampleValue[]> = {};
    for (const col of reversedSchema) {
      reorderedSamples[col.name] = t.samplesByColumn[col.name];
    }
    return { ...t, schema: reversedSchema, samplesByColumn: reorderedSamples };
  });
}

/** Return a copy of `tables` with the table order reversed. */
function reverseTableOrder(tables: TableSample[]): TableSample[] {
  return [...tables].reverse();
}

/** Index proposals by their stable pair id for order-independent comparison. */
function byId(proposals: MatchProposal[]): Map<string, MatchProposal> {
  const map = new Map<string, MatchProposal>();
  for (const p of proposals) {
    map.set(p.id, p);
  }
  return map;
}

/**
 * Assert two proposal lists are determinism-equivalent: same id set, and for
 * each id an identical confidence, components breakdown, canonical left/right
 * orientation, reason, and source. The engine's documented ordering (confidence
 * desc, then stable pair id) is itself a pure function of the proposal set, so
 * comparing by id both proves the set is identical and lets the final-ordering
 * check below prove the sort is stable regardless of input order.
 */
function expectEquivalentProposals(
  a: MatchProposal[],
  b: MatchProposal[],
): void {
  expect(b).toHaveLength(a.length);
  const aById = byId(a);
  const bById = byId(b);
  expect([...bById.keys()].sort()).toEqual([...aById.keys()].sort());

  for (const [id, pa] of aById) {
    const pb = bById.get(id);
    expect(pb, `proposal ${id} present in both runs`).toBeDefined();
    if (!pb) {
      continue;
    }
    // Bit-for-bit identical confidence — the formula is a pure function of the
    // order-independent components.
    expect(pb.confidence).toBe(pa.confidence);
    expect(pb.components).toEqual(pa.components);
    expect(pb.left).toEqual(pa.left);
    expect(pb.right).toEqual(pa.right);
    expect(pb.reason).toBe(pa.reason);
    expect(pb.source).toBe(pa.source);
  }

  // Final ordering must also be identical: the id sequence is the engine's
  // deterministic sort output, so it must match exactly (not just as a set).
  expect(b.map((p) => p.id)).toEqual(a.map((p) => p.id));
}

// ── Component-level determinism ────────────────────────────────────────────────

describe("Property 11: Rules-engine determinism — component scorers", () => {
  it("nameSim returns the identical value on repeated calls", () => {
    fc.assert(
      fc.property(columnName, columnName, (a, b) => {
        expect(nameSim(a, b)).toBe(nameSim(a, b));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("typeCompat returns the identical value on repeated calls", () => {
    fc.assert(
      fc.property(columnType, columnType, (a, b) => {
        expect(typeCompat(a, b)).toBe(typeCompat(a, b));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("valueOverlap returns the identical value on repeated calls (and for a reversed sample list)", () => {
    fc.assert(
      fc.property(sampleValues, sampleValues, (sa, sb) => {
        const once = valueOverlap(sa, sb);
        // Repeating the exact call is identical...
        expect(valueOverlap(sa, sb)).toBe(once);
        // ...and the overlap is a set computation, so re-ordering the sample
        // lists must not change it.
        expect(valueOverlap([...sa].reverse(), [...sb].reverse())).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("confidence is a pure function of its components (same in → same out)", () => {
    fc.assert(
      fc.property(
        fc.record({
          nameSim: fc.double({ min: 0, max: 1, noNaN: true }),
          typeCompat: fc.double({ min: 0, max: 1, noNaN: true }),
          valueOverlap: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        (components: MatchComponents) => {
          const once = confidence(components);
          expect(confidence({ ...components })).toBe(once);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ── Engine-level determinism (the headline property) ────────────────────────────

describe("Property 11: Rules-engine determinism — matchTables", () => {
  it("matchTables(tables) run twice on the SAME input is bit-for-bit identical (display set)", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const first = matchTables(tables);
        const second = matchTables(tables);
        // Deep-equal, including order: identical input → identical output.
        expect(second).toEqual(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("matchTables run twice is bit-for-bit identical for the full (un-thresholded) scored set too", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const first = matchTables(tables, false);
        const second = matchTables(tables, false);
        expect(second).toEqual(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("matchTables is insensitive to the order of COLUMNS within each table", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const original = matchTables(tables, false);
        const reordered = matchTables(reverseColumnOrder(tables), false);
        expectEquivalentProposals(original, reordered);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("matchTables is insensitive to the order of TABLES in the input", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const original = matchTables(tables, false);
        const reordered = matchTables(reverseTableOrder(tables), false);
        expectEquivalentProposals(original, reordered);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("matchTables is insensitive to BOTH table and column reordering at once", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const original = matchTables(tables);
        const reordered = matchTables(
          reverseColumnOrder(reverseTableOrder(tables)),
        );
        expectEquivalentProposals(original, reordered);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("every emitted proposal's confidence equals its components recomputed (determinism of the score)", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        for (const proposal of matchTables(tables, false)) {
          expect(proposal.confidence).toBe(confidence(proposal.components));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ── Engine wiring: createRulesEngine().match delegates to the pure matcher ──────

describe("Property 11: Rules-engine determinism — createRulesEngine().match", () => {
  // `match` is pure over `tables`; the injected DuckDBService is only used by
  // `clean`. A throwing stub proves `match` never touches it.
  const db = {
    query: () => {
      throw new Error("match must not touch DuckDB");
    },
  } as unknown as DuckDBService;

  it("engine.match(tables) is identical across repeated calls and equals matchTables(tables)", () => {
    const engine = createRulesEngine(db);
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const first = engine.match(tables);
        const second = engine.match(tables);
        expect(second).toEqual(first);
        // And it is exactly the pure matcher's display set.
        expect(first).toEqual(matchTables(tables));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ── Pure cleaning-logic determinism (no DuckDB) ─────────────────────────────────
//
// The cleaning engine's SQL-backed counts (duplicate-rows, outliers) are
// covered by cleaning-rules.duckdb.test.ts. Here we pin the determinism of the
// PURE cleaning logic that derives directly from the bounded samples — the part
// of Property 11 that needs no DuckDB.

/** A non-null category sample (value + count). */
const nonNullSample: fc.Arbitrary<NonNullSample> = fc.record({
  value: sampleString,
  count: fc.integer({ min: 1, max: 50 }),
});

const nonNullSamples: fc.Arbitrary<NonNullSample[]> = fc.array(nonNullSample, {
  maxLength: 15,
});

describe("Property 11: Rules-engine determinism — pure cleaning logic", () => {
  it("normalizeWhitespace is deterministic and idempotent", () => {
    fc.assert(
      fc.property(sampleString, (value) => {
        const once = normalizeWhitespace(value);
        expect(normalizeWhitespace(value)).toBe(once);
        // Idempotent: re-normalizing normalized text is a no-op.
        expect(normalizeWhitespace(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("foldCategory is deterministic and idempotent", () => {
    fc.assert(
      fc.property(sampleString, (value) => {
        const once = foldCategory(value);
        expect(foldCategory(value)).toBe(once);
        expect(foldCategory(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("clusterCategories yields the identical clustering on repeated calls and regardless of input order", () => {
    fc.assert(
      fc.property(nonNullSamples, (samples) => {
        // Normalize a clustering to an order-independent, comparable shape:
        // each cluster keyed by its folded representative, with its member
        // surface forms sorted; the whole list sorted by folded key.
        const shape = (ss: NonNullSample[]): Array<[string, string[]]> =>
          clusterCategories(ss)
            .map(
              (c): [string, string[]] => [
                c.folded,
                c.members.map((m) => m.value).sort(),
              ],
            )
            .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

        const once = shape(samples);
        // Repeating the exact call is identical.
        expect(shape(samples)).toEqual(once);
        // Re-ordering the input samples must not change the clustering.
        expect(shape([...samples].reverse())).toEqual(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
