/**
 * Property-based tests for the display-threshold filter.
 *
 * Feature: frankendata-ai-stitching, Property 9: Below-threshold proposals
 * never displayed.
 *
 * Validates: Requirements 1.6, 10.9
 *
 * Property 9 statement (design, "Correctness Properties"): *For any* computed
 * `ProposalSet`, no `MatchProposal` with `ConfidenceScore` below
 * `MATCH_DISPLAY_THRESHOLD` appears in the set surfaced to the UI.
 *
 * The design ("Fuzzy Name Similarity and Scoring") pins the contract: the
 * engine computes a confidence in `[0, 1]` for every surviving pair, keeps the
 * full scored set internally, and surfaces to the UI only the pairs with
 * `confidence >= MATCH_DISPLAY_THRESHOLD` (Req 1.6). The raw set is retained
 * for tests via the `displayOnly=false` path.
 *
 * The invariant is proved in both directions:
 *   (a) every proposal in the displayed set has `confidence >=
 *       MATCH_DISPLAY_THRESHOLD`; and
 *   (b) every full-set proposal with `confidence < MATCH_DISPLAY_THRESHOLD` is
 *       absent from the displayed set (the engine keeps it internally but never
 *       surfaces it), while every full-set proposal `>= threshold` is present —
 *       i.e. the displayed set is exactly the thresholded slice of the full
 *       set, nothing added, nothing silently dropped.
 *
 * Functions under test (task 6): {@link matchTables} (the engine entry point,
 * with its `displayOnly` switch) and {@link createRulesEngine}'s `match`
 * (task 9 wiring — the method the `StitchController` actually calls to build the
 * UI-facing `ProposalSet.matches`). The {@link MATCH_DISPLAY_THRESHOLD}
 * constant comes from `./types`.
 *
 * This is a pure-logic property: no DuckDB, no network. Samples are supplied
 * directly as {@link TableSample}s (what the SampleReader would otherwise read
 * from DuckDB), so the test exercises the scoring/threshold logic in isolation.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ColumnSchema, ColumnType } from "../types";
import type { DuckDBService } from "../types";
import { matchTables } from "./match-scoring";
import { createRulesEngine } from "./rules-engine";
import {
  MATCH_DISPLAY_THRESHOLD,
  type MatchProposal,
  type SampleValue,
  type TableSample,
} from "./types";

/** Property-test iteration count (design: fast-check, >= 100 iterations). */
const NUM_RUNS = 200;

const ALL_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Column names drawn from a small, deliberately overlapping vocabulary (mixing
 * case/separators) so generated tables frequently produce real, surviving
 * proposals across the full confidence range — some clearly above the display
 * threshold, some clearly below — rather than only gated-out or only perfect
 * matches. This is what makes the filter actually exercised (not vacuously
 * true): see the "mix" guard assertions below.
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
 * across tables overlap partially — partial overlap yields mid-range
 * `valueOverlap`, which (combined with varied name similarity) spreads the
 * final confidence across both sides of the threshold.
 */
const sampleString = fc.constantFrom(
  "Swamp Wraith",
  "swamp-wraith",
  "Bog Golem",
  "Night Howler",
  "Mire Shade",
  "42",
  "7",
  "13",
  "2024-01-01",
  "2023-06-15",
  "alpha",
  "beta",
  "gamma",
  "delta",
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Index proposals by their stable pair id. */
function byId(proposals: MatchProposal[]): Map<string, MatchProposal> {
  const map = new Map<string, MatchProposal>();
  for (const p of proposals) {
    map.set(p.id, p);
  }
  return map;
}

// ── The headline property: the display set never contains below-threshold ─────

describe("Property 9: Below-threshold proposals never displayed — matchTables", () => {
  it("(a) every proposal in the displayed set has confidence >= MATCH_DISPLAY_THRESHOLD", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        for (const proposal of matchTables(tables)) {
          expect(proposal.confidence).toBeGreaterThanOrEqual(
            MATCH_DISPLAY_THRESHOLD,
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(b) every below-threshold full-set proposal is absent from the displayed set, and every >= threshold one is present", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const full = matchTables(tables, false);
        const displayed = matchTables(tables);
        const displayedById = byId(displayed);

        for (const proposal of full) {
          if (proposal.confidence < MATCH_DISPLAY_THRESHOLD) {
            // Kept internally in the full set, but NEVER surfaced to the UI.
            expect(
              displayedById.has(proposal.id),
              `below-threshold proposal ${proposal.id} (conf=${proposal.confidence}) must not be displayed`,
            ).toBe(false);
          } else {
            // At/above threshold: must be surfaced, unchanged.
            const shown = displayedById.get(proposal.id);
            expect(
              shown,
              `>= threshold proposal ${proposal.id} must be displayed`,
            ).toBeDefined();
            if (shown) {
              expect(shown.confidence).toBe(proposal.confidence);
              expect(shown.components).toEqual(proposal.components);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("the displayed set is exactly the thresholded slice of the full set (same size, same ids)", () => {
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const full = matchTables(tables, false);
        const displayed = matchTables(tables);

        const expectedIds = full
          .filter((p) => p.confidence >= MATCH_DISPLAY_THRESHOLD)
          .map((p) => p.id)
          .sort();
        const actualIds = displayed.map((p) => p.id).sort();

        // Nothing added, nothing silently dropped: the displayed set is the
        // thresholded slice and nothing else.
        expect(actualIds).toEqual(expectedIds);
        // The displayed set is never larger than the retained full set.
        expect(displayed.length).toBeLessThanOrEqual(full.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ── Non-vacuity guard: the filter is genuinely exercised ───────────────────────
//
// A below-threshold-is-absent property is vacuously satisfied if generated
// inputs never produce below-threshold proposals (or never produce displayed
// ones). Across the whole run we require seeing BOTH a below-threshold proposal
// in the full set AND at least one displayed proposal — so the filter must
// actually drop something at least once while also surfacing matches.

describe("Property 9: the display-threshold filter is actually exercised (non-vacuity)", () => {
  it("across many inputs, some full-set proposals fall below threshold and some are displayed", () => {
    let sawBelowThreshold = false;
    let sawDisplayed = false;

    fc.assert(
      fc.property(distinctTables, (tables) => {
        const full = matchTables(tables, false);
        const displayed = matchTables(tables);

        if (full.some((p) => p.confidence < MATCH_DISPLAY_THRESHOLD)) {
          sawBelowThreshold = true;
        }
        if (displayed.length > 0) {
          sawDisplayed = true;
        }
      }),
      { numRuns: NUM_RUNS },
    );

    expect(
      sawBelowThreshold,
      "generators should produce some below-threshold proposals so the filter is non-vacuous",
    ).toBe(true);
    expect(
      sawDisplayed,
      "generators should produce some displayed proposals so the invariant is non-vacuous",
    ).toBe(true);
  });
});

// ── Engine wiring: createRulesEngine().match surfaces only the display set ──────
//
// The StitchController builds the UI-facing ProposalSet.matches from
// engine.match(...). This pins that the wired method applies the threshold too
// (it must equal matchTables' display set, never the full set).

describe("Property 9: Below-threshold proposals never displayed — createRulesEngine().match", () => {
  // `match` is pure over `tables`; the injected DuckDBService is only used by
  // `clean`. A throwing stub proves `match` never touches it.
  const db = {
    query: () => {
      throw new Error("match must not touch DuckDB");
    },
  } as unknown as DuckDBService;

  it("engine.match(tables) surfaces only >= threshold proposals (equals the display set, never the full set)", () => {
    const engine = createRulesEngine(db);
    fc.assert(
      fc.property(distinctTables, (tables) => {
        const matches = engine.match(tables);
        for (const proposal of matches) {
          expect(proposal.confidence).toBeGreaterThanOrEqual(
            MATCH_DISPLAY_THRESHOLD,
          );
        }
        // It is exactly the pure matcher's display set — the thresholded slice.
        expect(matches).toEqual(matchTables(tables));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
