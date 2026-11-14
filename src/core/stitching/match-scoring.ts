/**
 * Deterministic match scoring for the stitching engine (Feature 2, task 6).
 *
 * Pure, framework-agnostic (no React, DOM, or network) scoring of candidate
 * cross-table column matches. Given the per-table {@link TableSample}s produced
 * by the SampleReader (task 4), {@link matchTables} forms every unordered pair
 * of columns across distinct tables, applies the hard gates, scores the
 * survivors, and returns deduplicated {@link MatchProposal}s. It also exposes
 * the component scorers ({@link typeCompat}, {@link valueOverlap}) and the
 * combined {@link confidence} for unit/property testing.
 *
 * ## Scoring (design: "Fuzzy Name Similarity and Scoring")
 *
 *   confidence = 0.50 · nameSim + 0.20 · typeCompat + 0.30 · valueOverlap
 *
 * Weights sum to 1, so with every component in [0, 1] the confidence is in
 * [0, 1] (Req 1.3, Property: score bounds). Every component is a pure function
 * of the two columns' names, types, and bounded samples, so scoring is
 * deterministic (Req 5.2) and symmetric (Req 1.4).
 *
 * ## Hard gates (design: "Hard gates", Req 1.5)
 *
 * Before scoring, a pair is discarded entirely — symmetrically — when any of:
 *   1. the types are incompatible (`typeCompat == 0`, a matrix hard-zero);
 *   2. *either* column is boolean (booleans are never matched: their
 *      `{true,false}` domains make value overlap meaningless);
 *   3. the names are too dissimilar (`nameSim < NAME_SIM_FLOOR`).
 *
 * ## Value overlap (design: "valueOverlap")
 *
 * Overlap coefficient over the normalized distinct sample sets, scaled by a
 * small-set damping factor so tiny distinct sets cannot score high by chance:
 *
 *   valueOverlap = (|SA ∩ SB| / min(|SA|, |SB|)) · min(1, min(|SA|,|SB|) / 10)
 *
 * The sample values are normalized with the same trim + collapse-whitespace +
 * lowercase used for join keys (design: "valueOverlap", Req 7.8), so overlap
 * reflects post-cleaning reality.
 */

import type { ColumnType } from "../types";
import { nameSim } from "./name-similarity";
import {
  MATCH_DISPLAY_THRESHOLD,
  TYPE_COMPATIBILITY_MATRIX,
  type ColumnRef,
  type MatchProposal,
  type SampleValue,
  type TableSample,
} from "./types";

// ── Scoring weights (design: "Final confidence") ────────────────────────────
/** Weight on the fuzzy name-similarity component. */
export const NAME_SIM_WEIGHT = 0.5;
/** Weight on the type-compatibility component. */
export const TYPE_COMPAT_WEIGHT = 0.2;
/** Weight on the value-overlap component. */
export const VALUE_OVERLAP_WEIGHT = 0.3;

/**
 * Name-similarity floor hard gate (design: "Hard gates"). A pair whose names
 * score below this is discarded before scoring, so pairs that share only
 * incidental value overlap but have unrelated names never surface.
 */
export const NAME_SIM_FLOOR = 0.2;

/**
 * Minimum distinct-set size on the smaller side for value overlap to
 * contribute its full weight (design: "Small-set damping"). Below this, the
 * raw overlap is scaled down linearly.
 */
export const VALUE_OVERLAP_DAMPING_FULL_SIZE = 10;

/** Clamp a number to the inclusive range [0, 1]. */
function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Type compatibility in [0, 1] from the {@link TYPE_COMPATIBILITY_MATRIX}
 * (design: "Type compatibility matrix", Req 1.5). Symmetric: the matrix is
 * symmetric, so `typeCompat(a, b) === typeCompat(b, a)`. A `0` result is a hard
 * gate (the pair is discarded before scoring).
 */
export function typeCompat(a: ColumnType, b: ColumnType): number {
  return TYPE_COMPATIBILITY_MATRIX[a][b];
}

/**
 * Normalize a single sample value for the value-overlap set, using the same
 * trim + collapse-internal-whitespace + lowercase applied to join keys
 * (design: "valueOverlap", Req 7.8). Pure and idempotent.
 */
export function normalizeSampleValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Build the normalized distinct value set from a column's samples, excluding
 * nulls (nulls are not matching values, by design). Normalization can collapse
 * two distinct raw values into one, so the resulting set may be smaller than
 * the sample list.
 */
function normalizedValueSet(samples: SampleValue[]): Set<string> {
  const set = new Set<string>();
  for (const sample of samples) {
    if (sample.value === null) {
      continue;
    }
    set.add(normalizeSampleValue(sample.value));
  }
  return set;
}

/** Small-set damping factor (design: "Small-set damping"). Pure function of the two set sizes. */
function dampingFactor(sizeA: number, sizeB: number): number {
  const smaller = Math.min(sizeA, sizeB);
  return Math.min(1, smaller / VALUE_OVERLAP_DAMPING_FULL_SIZE);
}

/**
 * Value overlap in [0, 1] over two columns' samples (design: "valueOverlap").
 *
 *   raw      = |SA ∩ SB| / min(|SA|, |SB|)     (overlap coefficient)
 *   overlap  = raw · min(1, min(|SA|,|SB|) / 10)   (small-set damping)
 *
 * Either set empty → 0. Symmetric by construction (set intersection and `min`
 * are order-independent).
 */
export function valueOverlap(
  samplesA: SampleValue[],
  samplesB: SampleValue[]
): number {
  const setA = normalizedValueSet(samplesA);
  const setB = normalizedValueSet(samplesB);
  const sizeA = setA.size;
  const sizeB = setB.size;
  if (sizeA === 0 || sizeB === 0) {
    return 0;
  }

  // Count the intersection by iterating the smaller set.
  const [small, large] = sizeA <= sizeB ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const value of small) {
    if (large.has(value)) {
      intersection += 1;
    }
  }

  const raw = intersection / Math.min(sizeA, sizeB);
  return clamp01(raw * dampingFactor(sizeA, sizeB));
}

/** The deterministic component breakdown retained on every proposal. */
export interface MatchComponents {
  nameSim: number;
  typeCompat: number;
  valueOverlap: number;
}

/**
 * Combine the three components into the final confidence (design: "Final
 * confidence"). Weights sum to 1, so the result is in [0, 1] when each
 * component is.
 */
export function confidence(components: MatchComponents): number {
  return clamp01(
    NAME_SIM_WEIGHT * components.nameSim +
      TYPE_COMPAT_WEIGHT * components.typeCompat +
      VALUE_OVERLAP_WEIGHT * components.valueOverlap
  );
}

/**
 * Hard gates (design: "Hard gates", Req 1.5). Returns `true` when the pair must
 * be discarded (no proposal emitted). Evaluated symmetrically: each predicate
 * is independent of argument order.
 */
export function isHardGated(
  typeA: ColumnType,
  typeB: ColumnType,
  nameSimilarity: number
): boolean {
  // 1. Type incompatible (matrix hard-zero).
  if (typeCompat(typeA, typeB) === 0) {
    return true;
  }
  // 2. Either column boolean — booleans are never matched.
  if (typeA === "boolean" || typeB === "boolean") {
    return true;
  }
  // 3. Names too dissimilar.
  if (nameSimilarity < NAME_SIM_FLOOR) {
    return true;
  }
  return false;
}

/**
 * Stable, order-independent id for an unordered column pair. The two column
 * refs are sorted by `(tableName, columnName)` so `(A, B)` and `(B, A)` yield
 * the same id, giving symmetric dedup.
 */
export function pairId(a: ColumnRef, b: ColumnRef): string {
  const keyA = `${a.tableName}.${a.columnName}`;
  const keyB = `${b.tableName}.${b.columnName}`;
  const [first, second] = keyA <= keyB ? [keyA, keyB] : [keyB, keyA];
  return `match:${first}=${second}`;
}

/** Order two column refs deterministically by `(tableName, columnName)`. */
function orderRefs(a: ColumnRef, b: ColumnRef): [ColumnRef, ColumnRef] {
  const keyA = `${a.tableName}.${a.columnName}`;
  const keyB = `${b.tableName}.${b.columnName}`;
  return keyA <= keyB ? [a, b] : [b, a];
}

/** Round to 4 decimals for a stable, human-readable reason string. */
function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** One-line, plain-text reason describing why the pair was proposed. */
function buildReason(
  left: ColumnRef,
  right: ColumnRef,
  components: MatchComponents
): string {
  return (
    `"${left.tableName}.${left.columnName}" ↔ "${right.tableName}.${right.columnName}": ` +
    `name ${pct(components.nameSim)}, ` +
    `type ${pct(components.typeCompat)}, ` +
    `value overlap ${pct(components.valueOverlap)}`
  );
}

/**
 * Score every unordered cross-table column pair and return the deduplicated,
 * symmetric {@link MatchProposal}s whose confidence is at or above
 * {@link MATCH_DISPLAY_THRESHOLD}.
 *
 * Determinism: output order is sorted by descending confidence, then by the
 * stable pair id, so identical input always yields identical output (Req 5.2).
 *
 * @param tables         the per-table samples to match across.
 * @param displayOnly    when `true` (default), only proposals `>=`
 *                       {@link MATCH_DISPLAY_THRESHOLD} are returned (what the
 *                       UI sees, Req 1.6). Pass `false` to retain the full
 *                       scored set (used by tests and internal callers).
 */
export function matchTables(
  tables: TableSample[],
  displayOnly = true
): MatchProposal[] {
  const proposals: MatchProposal[] = [];
  // Guard against the same (A,B)/(B,A) pair being emitted twice.
  const seen = new Set<string>();

  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const tableA = tables[i];
      const tableB = tables[j];

      for (const colA of tableA.schema) {
        for (const colB of tableB.schema) {
          const refA: ColumnRef = {
            tableName: tableA.tableName,
            columnName: colA.name,
            type: colA.type,
          };
          const refB: ColumnRef = {
            tableName: tableB.tableName,
            columnName: colB.name,
            type: colB.type,
          };

          const nameSimilarity = nameSim(colA.name, colB.name);

          // Hard gates (symmetric): discard before scoring.
          if (isHardGated(colA.type, colB.type, nameSimilarity)) {
            continue;
          }

          const components: MatchComponents = {
            nameSim: nameSimilarity,
            typeCompat: typeCompat(colA.type, colB.type),
            valueOverlap: valueOverlap(
              tableA.samplesByColumn[colA.name] ?? [],
              tableB.samplesByColumn[colB.name] ?? []
            ),
          };

          const score = confidence(components);
          if (displayOnly && score < MATCH_DISPLAY_THRESHOLD) {
            continue;
          }

          const id = pairId(refA, refB);
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);

          const [left, right] = orderRefs(refA, refB);
          proposals.push({
            id,
            left,
            right,
            confidence: score,
            reason: buildReason(left, right, components),
            source: "rules",
            components,
          });
        }
      }
    }
  }

  // Deterministic order: highest confidence first, then stable pair id.
  proposals.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return proposals;
}
