/**
 * Property-based tests for confidence-score bounds.
 *
 * Feature: frankendata-ai-stitching, Property 2: Confidence score bounds
 *
 * Validates: Requirements 1.3, 10.2, 11.4
 *
 * Property 2 statement: For any proposal produced by the engine (before or
 * after AI refinement/validation), its `ConfidenceScore` lies in the inclusive
 * range 0 to 1. This test pins the *rules-engine* side of that invariant (the
 * AI refinement/validation clamp is exercised separately by Property 12, task
 * 20): every confidence `matchTables`/`RulesEngine.match` emits, and every
 * component it is built from, stays within its defined bounds for arbitrary
 * generated columns and samples.
 *
 * Concretely, for arbitrary tables:
 *   - each proposal's `confidence` ∈ [0, 1] (Req 1.3);
 *   - each component is within its own defined bound — `nameSim` ∈ [0, 1],
 *     `typeCompat` ∈ [0, 1] (a matrix entry, in fact one of {0, 0.3, 1}),
 *     `valueOverlap` ∈ [0, 1];
 *   - the `confidence`/`nameSim`/`typeCompat`/`valueOverlap` scorers each
 *     return a finite number in [0, 1] directly, for arbitrary inputs — even
 *     adversarial component values outside [0, 1] fed to `confidence` are
 *     clamped back into range.
 *
 * The functions under test live in `./match-scoring` (task 6):
 *   - {@link matchTables} — the engine entry point (`RulesEngine.match`);
 *   - the component scorers {@link typeCompat}, {@link valueOverlap},
 *     {@link confidence};
 * together with {@link nameSim} from `./name-similarity`.
 *
 * This is a pure-logic property: no DuckDB, no network. Samples are supplied
 * directly as {@link TableSample}s (what the SampleReader would otherwise read
 * from DuckDB), so the test exercises the scoring/gating logic in isolation.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ColumnSchema, ColumnType } from "../types";
import { nameSim } from "./name-similarity";
import { confidence, matchTables, typeCompat, valueOverlap } from "./match-scoring";
import type { SampleValue, TableSample } from "./types";

/** Property-test iteration count (design: fast-check, >= 100 iterations). */
const NUM_RUNS = 200;

const ALL_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * A column name drawn from a small, deliberately overlapping vocabulary so that
 * generated tables frequently produce columns whose names are similar (and thus
 * pass the `nameSim >= 0.2` floor and surface real proposals), while still
 * exercising dissimilar pairs. Mixing cases/separators also stresses name
 * normalization inside `nameSim`.
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
  "score"
);

/**
 * A free-form name generator too: unconstrained unicode strings stress the
 * normalizer (NFKC, camel/snake splitting) and confirm `nameSim` stays bounded
 * even for names the small vocabulary above would never produce.
 */
const arbitraryName = fc.string({ maxLength: 24 });

/** A column type. */
const columnType: fc.Arbitrary<ColumnType> = fc.constantFrom(...ALL_TYPES);

/**
 * A single sampled value drawn from a small shared vocabulary so distinct value
 * sets across two tables genuinely overlap often (exercising the `valueOverlap`
 * component rather than always scoring 0), plus occasional nulls (excluded from
 * the matching set by design).
 */
const sampleString = fc.constantFrom(
  "Swamp Wraith",
  "swamp-wraith",
  "Bog Golem",
  "Night Howler",
  "true",
  "false",
  "42",
  "7",
  "2024-01-01",
  "alpha",
  "beta",
  "gamma"
);

/** A column's frequency-carrying samples (counts are arbitrary positive ints). */
const sampleValues: fc.Arbitrary<SampleValue[]> = fc.array(
  fc.record({
    value: fc.oneof(
      sampleString as fc.Arbitrary<string | null>,
      fc.constant<string | null>(null),
      fc.string({ maxLength: 20 }) as fc.Arbitrary<string | null>
    ),
    count: fc.integer({ min: 1, max: 50 }),
  }),
  { maxLength: 15 }
);

/** One column: a (unique-within-table) name, a type, and its samples. */
interface GenColumn {
  name: string;
  type: ColumnType;
  samples: SampleValue[];
}

/** A generated table: a name and 1..5 columns with unique names. */
const genTable: fc.Arbitrary<TableSample> = fc
  .tuple(
    fc.constantFrom("monsters", "experiments", "lab_log", "intake"),
    fc.uniqueArray(
      fc.record({
        name: columnName,
        type: columnType,
        samples: sampleValues,
      }),
      {
        minLength: 1,
        maxLength: 5,
        selector: (col: GenColumn) => col.name,
      }
    )
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
    return {
      tableName,
      rowCount: 0,
      schema,
      samplesByColumn,
    };
  });

/**
 * A set of 2..4 tables with DISTINCT table names (matching only happens
 * cross-table). Multiple tables stress every unordered cross-table pair the
 * engine forms, not just a single pair.
 */
const distinctTables: fc.Arbitrary<TableSample[]> = fc
  .uniqueArray(genTable, {
    minLength: 2,
    maxLength: 4,
    selector: (t: TableSample) => t.tableName,
  });

/** A score that may be in range, out of range, non-finite — fed to `confidence`. */
const arbitraryScore = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.double({ noNaN: true }), // any finite double, incl. negatives / > 1
  fc.constantFrom(-5, -0.0001, 1.0001, 10)
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Assert a value is a finite number within the inclusive range [lo, hi]. */
function expectInRange(value: number, lo: number, hi: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(lo);
  expect(value).toBeLessThanOrEqual(hi);
}

// ── Component-level bounds ─────────────────────────────────────────────────────

describe("Property 2: Confidence score bounds — component scorers", () => {
  it("nameSim(a, b) is a finite number in [0, 1]", () => {
    fc.assert(
      fc.property(
        fc.oneof(columnName, arbitraryName),
        fc.oneof(columnName, arbitraryName),
        (a, b) => {
          expectInRange(nameSim(a, b), 0, 1);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("typeCompat(a, b) is in [0, 1] for every type pair", () => {
    fc.assert(
      fc.property(columnType, columnType, (a, b) => {
        expectInRange(typeCompat(a, b), 0, 1);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("valueOverlap(SA, SB) is a finite number in [0, 1]", () => {
    fc.assert(
      fc.property(sampleValues, sampleValues, (sa, sb) => {
        expectInRange(valueOverlap(sa, sb), 0, 1);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("confidence(components) is in [0, 1] for in-range components", () => {
    fc.assert(
      fc.property(
        fc.record({
          nameSim: fc.double({ min: 0, max: 1, noNaN: true }),
          typeCompat: fc.double({ min: 0, max: 1, noNaN: true }),
          valueOverlap: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        (components) => {
          expectInRange(confidence(components), 0, 1);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("confidence clamps even adversarial out-of-range components into [0, 1]", () => {
    // Guards the clamp: no matter what component values arrive (negative,
    // > 1, large), the emitted confidence never escapes [0, 1].
    fc.assert(
      fc.property(
        fc.record({
          nameSim: arbitraryScore,
          typeCompat: arbitraryScore,
          valueOverlap: arbitraryScore,
        }),
        (components) => {
          expectInRange(confidence(components), 0, 1);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

// ── Engine-level bounds (the headline property) ────────────────────────────────

describe("Property 2: Confidence score bounds — matchTables / RulesEngine.match", () => {
  it("every displayed proposal's confidence and components are in [0, 1]", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        for (const proposal of matchTables(tables)) {
          expectInRange(proposal.confidence, 0, 1);
          expectInRange(proposal.components.nameSim, 0, 1);
          expectInRange(proposal.components.typeCompat, 0, 1);
          expectInRange(proposal.components.valueOverlap, 0, 1);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("every proposal in the full (un-thresholded) scored set is in [0, 1] too", () => {
    // displayOnly=false retains every scored survivor, so the bound holds for
    // the complete internal set the engine keeps, not just the display slice.
    fc.assert(
      fc.property(distinctTables, (tables) => {
        for (const proposal of matchTables(tables, false)) {
          expectInRange(proposal.confidence, 0, 1);
          expectInRange(proposal.components.nameSim, 0, 1);
          expectInRange(proposal.components.typeCompat, 0, 1);
          expectInRange(proposal.components.valueOverlap, 0, 1);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
