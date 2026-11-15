/**
 * Key-likeness for the default join key and the default anchor (join-key work).
 *
 * A join key is only useful when it identifies rows on at least one side.
 * Ranking candidate pairs by match confidence alone can pick a low-cardinality
 * column (a country, a status) that matches well by name and values but fans
 * the join out. This module measures how key-like each column is and ranks
 * candidate pairs by it.
 *
 * ## Distinct ratio
 *
 *   distinctRatio(column) = distinct normalized non-null values / non-null cells
 *
 * Values are normalized with the same trim, whitespace collapse and lowercase
 * the value overlap and the join itself use, so `"INFO@x.example"` and
 * `" info@x.example "` count once. When a duplicate-rows cleanup is proposed for
 * the table, the non-null count is scaled to the rows that would remain, so a
 * duplicated customer row does not make its key look repeated.
 *
 * ## Choosing a default key
 *
 * For one pair of tables, among its candidate matches:
 *
 *   1. `keyRatio = max(left ratio, right ratio)`. A key only has to identify
 *      rows on ONE side (the other side may repeat: that is a many-to-one join).
 *      A candidate whose keyRatio is below 0.5 (neither side is even half
 *      distinct) is used only when no other candidate exists.
 *   2. A candidate that is unique on a side (keyRatio 1) ranks above the rest.
 *   3. Within that group the score is `confidence x min(left ratio, right ratio)`.
 *   4. Similar-confidence refinement: while a candidate within 0.1 confidence of
 *      the pick has a higher keyRatio, switch to it. This makes "never a lower
 *      distinct ratio than an alternative of similar confidence" true by
 *      construction.
 *
 * ## Choosing a default anchor
 *
 * When the chosen key is unique on one side and repeated on the other, the
 * anchor is the side where it repeats (the "many" side), so the LEFT JOIN is
 * many-to-one and the result has as many rows as the anchor. Otherwise the
 * anchor is the table with the most rows.
 *
 * Pure and framework-agnostic.
 */

import { normalizeSampleValue } from "./match-scoring";
import {
  MAX_SAMPLE_VALUES_PER_COLUMN,
  type CleaningProposal,
  type ColumnKeyStats,
  type MatchProposal,
  type TableSample,
} from "./types";

/** Below this key ratio a pair is used only when nothing better exists. */
export const KEY_RATIO_FLOOR = 0.5;

/** Two candidates within this confidence distance count as "similar". */
export const SIMILAR_CONFIDENCE = 0.1;

/** The key of a column in {@link ProposalSet.columnStats}. */
export function statsKey(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

/** Row counts before and after a proposed duplicate-rows cleanup, per table. */
function dedupeFactors(cleanings: readonly CleaningProposal[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of cleanings) {
    if (c.kind !== "duplicate-rows") continue;
    const before = (c.before as { rowCount?: unknown } | undefined)?.rowCount;
    const after = (c.after as { rowCount?: unknown } | undefined)?.rowCount;
    if (typeof before === "number" && typeof after === "number" && before > 0 && after >= 0) {
      out.set(c.target.tableName, Math.min(1, after / before));
    }
  }
  return out;
}

/** Key stats for one column of one table sample. */
export function columnKeyStats(
  sample: TableSample,
  columnName: string,
  rowFactor = 1
): ColumnKeyStats {
  const entries = (sample.samplesByColumn[columnName] ?? []).filter(
    (s) => s.value !== null
  );
  const normalized = new Set<string>();
  let sampledNonNull = 0;
  for (const s of entries) {
    normalized.add(normalizeSampleValue(s.value as string));
    sampledNonNull += s.count;
  }

  let nonNull = sampledNonNull;
  let distinct = normalized.size;
  const totals = sample.columnTotals?.[columnName];
  if (totals !== undefined && entries.length >= MAX_SAMPLE_VALUES_PER_COLUMN) {
    // The sample list was cut: use the exact totals, and scale the normalized
    // distinct count by how much normalization shrank the sampled values.
    nonNull = totals.nonNull;
    distinct = Math.round((totals.rawDistinct * normalized.size) / entries.length);
  }

  // Assume the proposed duplicate-row cleanup: fewer cells, same distinct values.
  const effectiveNonNull = Math.max(distinct, Math.round(nonNull * rowFactor));
  const distinctRatio =
    effectiveNonNull === 0 ? 0 : Math.min(1, distinct / effectiveNonNull);
  return { nonNull: effectiveNonNull, distinct, distinctRatio };
}

/** Key stats for every column of every sampled table. */
export function computeColumnKeyStats(
  samples: readonly TableSample[],
  cleanings: readonly CleaningProposal[]
): Record<string, ColumnKeyStats> {
  const factors = dedupeFactors(cleanings);
  const out: Record<string, ColumnKeyStats> = {};
  for (const sample of samples) {
    const factor = factors.get(sample.tableName) ?? 1;
    for (const column of sample.schema) {
      out[statsKey(sample.tableName, column.name)] = columnKeyStats(
        sample,
        column.name,
        factor
      );
    }
  }
  return out;
}

/** The two side ratios of a match. A side without stats counts as unique. */
export function sideRatios(
  match: Pick<MatchProposal, "left" | "right">,
  stats: Readonly<Record<string, ColumnKeyStats>> | undefined
): { left: number; right: number } {
  const get = (t: string, c: string): number =>
    stats?.[statsKey(t, c)]?.distinctRatio ?? 1;
  return {
    left: get(match.left.tableName, match.left.columnName),
    right: get(match.right.tableName, match.right.columnName),
  };
}

/** The more key-like side of a match: how well it identifies rows on one side. */
export function keyRatio(
  match: Pick<MatchProposal, "left" | "right">,
  stats: Readonly<Record<string, ColumnKeyStats>> | undefined
): number {
  const r = sideRatios(match, stats);
  return Math.max(r.left, r.right);
}

interface Ranked {
  match: MatchProposal;
  keyRatio: number;
  score: number;
}

function byScore(a: Ranked, b: Ranked): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.match.confidence !== a.match.confidence) {
    return b.match.confidence - a.match.confidence;
  }
  return a.match.id < b.match.id ? -1 : a.match.id > b.match.id ? 1 : 0;
}

/**
 * Pick the default join key among the candidate matches of ONE table pair.
 * Returns `undefined` for an empty list. See the module header for the rules.
 */
export function chooseDefaultMatch(
  candidates: readonly MatchProposal[],
  stats: Readonly<Record<string, ColumnKeyStats>> | undefined
): MatchProposal | undefined {
  if (candidates.length === 0) return undefined;
  const all: Ranked[] = candidates.map((match) => {
    const r = sideRatios(match, stats);
    return {
      match,
      keyRatio: Math.max(r.left, r.right),
      score: match.confidence * Math.min(r.left, r.right),
    };
  });

  // 1. Drop candidates where neither side is half distinct, unless that is all there is.
  const kept = all.filter((x) => x.keyRatio >= KEY_RATIO_FLOOR);
  const pool = kept.length > 0 ? kept : all;
  // 2. Prefer a key that is unique on a side.
  const unique = pool.filter((x) => x.keyRatio >= 1);
  const ranked = unique.length > 0 ? unique : pool;
  // 3. Best score.
  let best = [...ranked].sort(byScore)[0];
  // 4. Similar-confidence refinement toward the more key-like candidate.
  for (;;) {
    const better = ranked
      .filter(
        (x) =>
          x.keyRatio > best.keyRatio &&
          Math.abs(x.match.confidence - best.match.confidence) <= SIMILAR_CONFIDENCE
      )
      .sort((a, b) => (b.keyRatio !== a.keyRatio ? b.keyRatio - a.keyRatio : byScore(a, b)))[0];
    if (better === undefined) break;
    best = better;
  }
  return best.match;
}

/**
 * The "many" side of a key: the table where the key repeats, when the key is
 * unique on the other side. `undefined` when both sides are unique, both repeat,
 * or there are no stats.
 */
export function manySideOf(
  match: Pick<MatchProposal, "left" | "right">,
  stats: Readonly<Record<string, ColumnKeyStats>> | undefined
): string | undefined {
  if (stats === undefined) return undefined;
  const r = sideRatios(match, stats);
  const leftUnique = r.left >= 1;
  const rightUnique = r.right >= 1;
  if (leftUnique && !rightUnique) return match.right.tableName;
  if (rightUnique && !leftUnique) return match.left.tableName;
  return undefined;
}
