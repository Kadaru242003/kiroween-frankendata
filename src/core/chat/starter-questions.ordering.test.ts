/**
 * Unit tests for starter-chip display ordering (bug fix: chip overflow).
 *
 * `orderStarterChips` puts the most useful chips first — stitch_<n>_result
 * tables before others, then category chips, then row-count, then numeric —
 * while staying STABLE (generation order preserved within a rank) so output
 * is deterministic.
 */

import { describe, expect, it } from "vitest";
import { orderStarterChips, type StarterChip } from "./starter-questions";

function chip(
  tableName: string,
  kind: StarterChip["kind"],
  tag: string
): StarterChip {
  return { tableName, kind, question: `${tag}`, sql: `-- ${tag}` };
}

describe("orderStarterChips", () => {
  it("orders by stitch-result table, then kind, stably within a rank", () => {
    // Deliberately scrambled input.
    const input: StarterChip[] = [
      chip("monsters", "numeric", "m-num"),
      chip("monsters", "row-count", "m-rows"),
      chip("stitch_1_result", "numeric", "s-num"),
      chip("monsters", "category", "m-cat"),
      chip("stitch_1_result", "category", "s-cat"),
      chip("experiments", "category", "e-cat"),
    ];
    const ordered = orderStarterChips(input).map((c) => c.question);
    expect(ordered).toEqual([
      // stitch_1_result first, by kind: category before numeric.
      "s-cat",
      "s-num",
      // then the rest, by kind: category, row-count, numeric.
      "m-cat",
      "e-cat",
      "m-rows",
      "m-num",
    ]);
  });

  it("is a pure, stable, deterministic reordering (no mutation)", () => {
    const input: StarterChip[] = [
      chip("a", "category", "a1"),
      chip("a", "category", "a2"),
      chip("b", "category", "b1"),
    ];
    const snapshot = input.map((c) => c.question);
    const ordered = orderStarterChips(input);
    // Same-rank chips keep their relative order.
    expect(ordered.map((c) => c.question)).toEqual(["a1", "a2", "b1"]);
    // Input array is not mutated.
    expect(input.map((c) => c.question)).toEqual(snapshot);
    // Deterministic: a second run yields the same order.
    expect(orderStarterChips(input).map((c) => c.question)).toEqual(
      ordered.map((c) => c.question)
    );
  });
});
