/**
 * Property-based tests for matching symmetry.
 *
 * Feature: frankendata-ai-stitching, Property 1: Matching symmetry
 *
 * Validates: Requirements 1.4, 5.2
 *
 * Property 1 statement: For any two tables A and B, the `MatchProposal`s
 * computed for (A, B) are equivalent to those computed for (B, A), with
 * identical `ConfidenceScore`s. Equivalence here is strict: the same set of
 * proposals (by stable pair id), each with an identical `confidence`, an
 * identical `components` breakdown (`nameSim` / `typeCompat` / `valueOverlap`),
 * and the same canonical `left`/`right` orientation — and a pair that is gated
 * out for (A, B) is gated out for (B, A) too.
 *
 * The functions under test live in `./match-scoring` (task 6):
 *   - {@link matchTables} — the engine entry point producing deduplicated,
 *     symmetric {@link MatchProposal}s across every unordered cross-table pair;
 *   - the component scorers {@link typeCompat}, {@link valueOverlap},
 *     {@link confidence}, and the {@link isHardGated} gate;
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
import {
  confidence,
  isHardGated,
  matchTables,
  typeCompat,
  valueOverlap,
} from "./match-scoring";
import type { MatchProposal, SampleValue, TableSample } from "./types";

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

/** A column type. */
const columnType: fc.Arbitrary<ColumnType> = fc.constantFrom(...ALL_TYPES);

/**
 * A single sampled value drawn from a small shared vocabulary so distinct value
 * sets across two tables genuinely overlap often (exercising the `valueOverlap`
 * component rather than always scoring 0).
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
    value: sampleString as fc.Arbitrary<string | null>,
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

/** Two tables with DISTINCT table names (matching only happens cross-table). */
const twoDistinctTables: fc.Arbitrary<[TableSample, TableSample]> = fc
  .tuple(genTable, genTable)
  .filter(([a, b]) => a.tableName !== b.tableName);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Index proposals by their stable pair id for order-independent comparison. */
function byId(proposals: MatchProposal[]): Map<string, MatchProposal> {
  const map = new Map<string, MatchProposal>();
  for (const proposal of proposals) {
    map.set(proposal.id, proposal);
  }
  return map;
}

/**
 * Assert two proposal lists are equivalent as sets: same ids, and for each id an
 * identical confidence, components breakdown, and canonical left/right
 * orientation. `matchTables` dedups and sorts by (confidence desc, id), so the
 * order itself is deterministic; comparing by id makes the invariant explicit
 * regardless of any incidental tie-order differences.
 */
function expectEquivalentProposals(
  forward: MatchProposal[],
  reverse: MatchProposal[]
): void {
  // Same number of proposals and same id set.
  expect(reverse).toHaveLength(forward.length);
  const forwardById = byId(forward);
  const reverseById = byId(reverse);
  expect([...reverseById.keys()].sort()).toEqual(
    [...forwardById.keys()].sort()
  );

  for (const [id, fwd] of forwardById) {
    const rev = reverseById.get(id);
    expect(rev, `proposal ${id} present in both orientations`).toBeDefined();
    if (!rev) {
      continue;
    }
    // Identical ConfidenceScore (exact — the formula is a pure function of the
    // order-independent components, so bit-for-bit equality must hold).
    expect(rev.confidence).toBe(fwd.confidence);
    // Identical components breakdown.
    expect(rev.components).toEqual(fwd.components);
    // Identical canonical orientation (orderRefs sorts by tableName.columnName,
    // so left/right do not flip with input order).
    expect(rev.left).toEqual(fwd.left);
    expect(rev.right).toEqual(fwd.right);
    // Identical reason (derived purely from the canonical left/right + components).
    expect(rev.reason).toBe(fwd.reason);
  }
}

// ── Component-level symmetry ───────────────────────────────────────────────────

describe("Property 1: Matching symmetry — component scorers", () => {
  it("nameSim(a, b) === nameSim(b, a)", () => {
    fc.assert(
      fc.property(columnName, columnName, (a, b) => {
        expect(nameSim(b, a)).toBe(nameSim(a, b));
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("typeCompat(a, b) === typeCompat(b, a)", () => {
    fc.assert(
      fc.property(columnType, columnType, (a, b) => {
        expect(typeCompat(b, a)).toBe(typeCompat(a, b));
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("valueOverlap(SA, SB) === valueOverlap(SB, SA)", () => {
    fc.assert(
      fc.property(sampleValues, sampleValues, (sa, sb) => {
        expect(valueOverlap(sb, sa)).toBe(valueOverlap(sa, sb));
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("isHardGated is independent of column argument order", () => {
    fc.assert(
      fc.property(columnName, columnName, columnType, columnType, (na, nb, ta, tb) => {
        // nameSim is symmetric, so the gate sees the same similarity both ways;
        // the gate predicates are each order-independent.
        const sim = nameSim(na, nb);
        expect(isHardGated(tb, ta, sim)).toBe(isHardGated(ta, tb, sim));
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("confidence is a pure function of its (order-independent) components", () => {
    fc.assert(
      fc.property(
        fc.record({
          nameSim: fc.double({ min: 0, max: 1, noNaN: true }),
          typeCompat: fc.double({ min: 0, max: 1, noNaN: true }),
          valueOverlap: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        (components) => {
          // Same components in → same score out (determinism underpinning symmetry).
          expect(confidence({ ...components })).toBe(confidence(components));
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

// ── Engine-level symmetry (the headline property) ──────────────────────────────

describe("Property 1: Matching symmetry — matchTables", () => {
  it("matchTables([A, B]) is equivalent to matchTables([B, A]) (display set)", () => {
    fc.assert(
      fc.property(twoDistinctTables, ([a, b]) => {
        const forward = matchTables([a, b]);
        const reverse = matchTables([b, a]);
        expectEquivalentProposals(forward, reverse);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("matchTables is symmetric for the full (un-thresholded) scored set too", () => {
    // displayOnly=false retains every scored survivor, so this also pins that a
    // pair gated out for (A, B) is gated out for (B, A) — gated pairs appear in
    // neither full set, non-gated pairs appear in both with identical scores.
    fc.assert(
      fc.property(twoDistinctTables, ([a, b]) => {
        const forward = matchTables([a, b], false);
        const reverse = matchTables([b, a], false);
        expectEquivalentProposals(forward, reverse);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("every surviving proposal's confidence equals its components recomputed", () => {
    // Guards the confidence<->components link the symmetry comparison relies on:
    // if confidence were order-sensitive in a way components did not capture,
    // this would catch it.
    fc.assert(
      fc.property(twoDistinctTables, ([a, b]) => {
        for (const proposal of matchTables([a, b], false)) {
          expect(proposal.confidence).toBe(confidence(proposal.components));
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
