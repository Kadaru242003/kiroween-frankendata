/**
 * Property-based tests for the type-incompatibility hard gate (incl. the
 * boolean exclusion).
 *
 * Feature: frankendata-ai-stitching, Property 3: Type-incompatibility gate
 *
 * Validates: Requirements 1.5
 *
 * Property 3 statement: For any pair of columns whose `ColumnType`s are
 * hard-incompatible (matrix `0.0`), no `MatchProposal` is produced. The design
 * (section "Hard gates (false-positive prevention, Req 1.5)") lists two
 * type-driven gates this test pins:
 *
 *   1. **Type incompatible** — `typeCompat(a, b) == 0.0` (a matrix hard-zero):
 *      number↔boolean, number↔date, boolean↔number, boolean↔date, date↔number,
 *      date↔boolean. The pair is discarded before scoring.
 *   2. **Either column is boolean** — booleans are never matched, on either
 *      side. This is stronger than the matrix alone: boolean↔boolean scores
 *      `1.0` in `TYPE_COMPATIBILITY_MATRIX`, yet the pair is STILL gated out
 *      because `{true,false}` domains make value overlap meaningless.
 *
 * Both gates must win regardless of how name-similar or value-overlapping the
 * two columns are. The generators below therefore build deliberately
 * *adversarial* pairs — identical names and fully-overlapping sample values —
 * so a proposal could only survive if the gate were broken. For such a pair,
 * `isHardGated` must return `true` and `matchTables` / `RulesEngine.match` must
 * emit no proposal naming it (whether `displayOnly` or the full scored set).
 *
 * The functions under test live in `./match-scoring` (task 6):
 *   - {@link isHardGated} — the symmetric gate predicate;
 *   - {@link matchTables} — the engine entry point (`RulesEngine.match`);
 *   - {@link typeCompat} and the {@link TYPE_COMPATIBILITY_MATRIX} it reads
 *     (from `./types`, task 3).
 *
 * This is a pure-logic property: no DuckDB, no network. Samples are supplied
 * directly as {@link TableSample}s (what the SampleReader would otherwise read
 * from DuckDB), so the test exercises the gating logic in isolation.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ColumnSchema, ColumnType } from "../types";
import { nameSim } from "./name-similarity";
import { isHardGated, matchTables, typeCompat } from "./match-scoring";
import {
  TYPE_COMPATIBILITY_MATRIX,
  type SampleValue,
  type TableSample,
} from "./types";

/** Property-test iteration count (design: fast-check, >= 100 iterations). */
const NUM_RUNS = 200;

const ALL_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

/** A column type. */
const columnType: fc.Arbitrary<ColumnType> = fc.constantFrom(...ALL_TYPES);

/** An unordered pair of types. */
type TypePair = readonly [ColumnType, ColumnType];

/** Every ordered type pair (16 total) — the whole compatibility matrix. */
const ALL_TYPE_PAIRS: TypePair[] = ALL_TYPES.flatMap((a) =>
  ALL_TYPES.map((b): TypePair => [a, b])
);

/** The type pairs that are hard-zero in the matrix (type-incompatible). */
const HARD_ZERO_PAIRS: TypePair[] = ALL_TYPE_PAIRS.filter(
  ([a, b]) => TYPE_COMPATIBILITY_MATRIX[a][b] === 0
);

/** Any type pair where at least one side is boolean. */
const BOOLEAN_PAIRS: TypePair[] = ALL_TYPE_PAIRS.filter(
  ([a, b]) => a === "boolean" || b === "boolean"
);

/**
 * The boolean↔boolean pair specifically: matrix value is 1.0 (compatible), so
 * it is the critical case that the *boolean exclusion* gate — not the matrix —
 * must catch. If the gate only consulted the matrix, this pair would leak.
 */
const BOOLEAN_BOOLEAN_PAIR: TypePair = ["boolean", "boolean"];

/**
 * Column names drawn so that a generated pair is frequently *identical* or
 * near-identical (nameSim ≈ 1) — the adversarial case that drives nameSim to
 * its max so the gate is the only thing that can discard the pair.
 */
const columnName = fc.constantFrom(
  "status",
  "Status",
  "sedated",
  "hazardous",
  "flag",
  "active",
  "id",
  "value",
  "name",
  "created_at"
);

/**
 * A small shared value vocabulary so two columns' sample sets overlap heavily
 * (often fully). Booleans sample as {true,false}; typed columns share concrete
 * values. High overlap is the adversarial condition: scoring would reward it,
 * so only the gate can keep the pair out.
 */
const sampleString = fc.constantFrom(
  "true",
  "false",
  "yes",
  "no",
  "1",
  "0",
  "active",
  "inactive"
);

/** A column's frequency-carrying samples. */
const sampleValues: fc.Arbitrary<SampleValue[]> = fc.array(
  fc.record({
    value: sampleString as fc.Arbitrary<string | null>,
    count: fc.integer({ min: 1, max: 50 }),
  }),
  { minLength: 1, maxLength: 12 }
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a two-table sample set holding exactly one column each, with the given
 * types/names/samples. Matching only happens cross-table, so one column per
 * distinct table isolates the single pair under test.
 */
function twoTablePair(
  typeA: ColumnType,
  typeB: ColumnType,
  nameA: string,
  nameB: string,
  samplesA: SampleValue[],
  samplesB: SampleValue[]
): TableSample[] {
  const schemaA: ColumnSchema[] = [{ name: nameA, type: typeA }];
  const schemaB: ColumnSchema[] = [{ name: nameB, type: typeB }];
  return [
    {
      tableName: "left_table",
      rowCount: 0,
      schema: schemaA,
      samplesByColumn: { [nameA]: samplesA },
    },
    {
      tableName: "right_table",
      rowCount: 0,
      schema: schemaB,
      samplesByColumn: { [nameB]: samplesB },
    },
  ];
}

// ── The matrix itself: hard-zeros are symmetric and exactly the cross-type set ─

describe("Property 3: Type-incompatibility gate — matrix hard-zeros", () => {
  it("every number/boolean/date cross-type pair is a hard-zero; same types (and string) are not", () => {
    for (const [a, b] of ALL_TYPE_PAIRS) {
      const value = TYPE_COMPATIBILITY_MATRIX[a][b];
      if (a === b) {
        // Same type is always fully compatible in the matrix.
        expect(value).toBe(1);
      } else if (a === "string" || b === "string") {
        // string is the weak-compatible bridge, never a hard-zero.
        expect(value).toBeGreaterThan(0);
      } else {
        // Distinct non-string types (number/boolean/date) are hard-zeros.
        expect(value).toBe(0);
      }
    }
  });

  it("the matrix is symmetric, so hard-zeros are order-independent", () => {
    for (const [a, b] of ALL_TYPE_PAIRS) {
      expect(TYPE_COMPATIBILITY_MATRIX[a][b]).toBe(
        TYPE_COMPATIBILITY_MATRIX[b][a]
      );
    }
  });
});

// ── isHardGated: type-incompatible pairs are gated for ANY name similarity ─────

describe("Property 3: Type-incompatibility gate — isHardGated", () => {
  it("gates every matrix hard-zero pair regardless of nameSim", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HARD_ZERO_PAIRS),
        // Any name similarity in [0, 1], incl. a perfect 1.0 name match.
        fc.double({ min: 0, max: 1, noNaN: true }),
        ([a, b], ns) => {
          expect(typeCompat(a, b)).toBe(0);
          expect(isHardGated(a, b, ns)).toBe(true);
          // Symmetric: order of the two types must not matter.
          expect(isHardGated(b, a, ns)).toBe(true);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("gates any pair with a boolean on either side, regardless of nameSim", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BOOLEAN_PAIRS),
        fc.double({ min: 0, max: 1, noNaN: true }),
        ([a, b], ns) => {
          expect(a === "boolean" || b === "boolean").toBe(true);
          expect(isHardGated(a, b, ns)).toBe(true);
          expect(isHardGated(b, a, ns)).toBe(true);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("gates boolean↔boolean even though its matrix value is 1.0 (exclusion, not the matrix)", () => {
    const [a, b] = BOOLEAN_BOOLEAN_PAIR;
    // The matrix alone would admit this pair...
    expect(TYPE_COMPATIBILITY_MATRIX[a][b]).toBe(1);
    // ...but the boolean-exclusion gate must still discard it, for any nameSim.
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (ns) => {
        expect(isHardGated(a, b, ns)).toBe(true);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});

// ── matchTables: gated pairs never surface as proposals, even adversarially ────

describe("Property 3: Type-incompatibility gate — matchTables / RulesEngine.match", () => {
  it("produces NO proposal for a type-incompatible pair, even with identical names and fully-overlapping values", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HARD_ZERO_PAIRS),
        columnName,
        sampleValues,
        ([a, b], name, samples) => {
          // Adversarial: same name on both sides (nameSim == 1) and the SAME
          // sample set on both sides (max value overlap). Only the type gate
          // can keep this out.
          fc.pre(nameSim(name, name) === 1);
          const tables = twoTablePair(a, b, name, name, samples, samples);

          // Neither the display slice nor the full scored set may name it.
          expect(matchTables(tables)).toHaveLength(0);
          expect(matchTables(tables, false)).toHaveLength(0);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("produces NO proposal when either column is boolean, incl. boolean↔boolean, under adversarial names/values", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BOOLEAN_PAIRS, BOOLEAN_BOOLEAN_PAIR),
        columnName,
        sampleValues,
        ([a, b], name, samples) => {
          const tables = twoTablePair(a, b, name, name, samples, samples);
          expect(matchTables(tables)).toHaveLength(0);
          expect(matchTables(tables, false)).toHaveLength(0);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("no emitted proposal ever pairs columns that are type-incompatible or boolean (arbitrary multi-column tables)", () => {
    // A broader sweep: arbitrary two-column-per-table inputs with independent
    // types/names/samples. Whatever survives scoring, every emitted proposal's
    // (left,right) types must be matrix-compatible AND neither may be boolean.
    const genColumn = fc.record({
      name: columnName,
      type: columnType,
      samples: sampleValues,
    });
    const genTable = fc
      .tuple(
        fc.constantFrom("monsters", "experiments", "lab_log"),
        fc.uniqueArray(genColumn, {
          minLength: 1,
          maxLength: 3,
          selector: (c) => c.name,
        })
      )
      .map(([tableName, columns]): TableSample => {
        const schema: ColumnSchema[] = columns.map((c) => ({
          name: c.name,
          type: c.type,
        }));
        const samplesByColumn: Record<string, SampleValue[]> = {};
        for (const c of columns) {
          samplesByColumn[c.name] = c.samples;
        }
        return { tableName, rowCount: 0, schema, samplesByColumn };
      });
    const distinctTables = fc.uniqueArray(genTable, {
      minLength: 2,
      maxLength: 3,
      selector: (t: TableSample) => t.tableName,
    });

    fc.assert(
      fc.property(distinctTables, (tables) => {
        for (const proposal of matchTables(tables, false)) {
          const { left, right } = proposal;
          // Never boolean on either side.
          expect(left.type).not.toBe("boolean");
          expect(right.type).not.toBe("boolean");
          // Never a matrix hard-zero.
          expect(typeCompat(left.type, right.type)).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
