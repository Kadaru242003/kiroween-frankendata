/**
 * Tests for the "Tables to stitch" selection model (fix batch, item 1).
 *
 * The bug: after loading demo data the checkboxes started UNCHECKED, so the
 * Stitch button was disabled. The requirement is all tables checked by default,
 * including tables loaded later. We model selection by the explicitly-UNCHECKED
 * set (a table is checked iff loaded and not unchecked), so the default is
 * naturally "all checked" with no per-arrival bookkeeping — robust under
 * StrictMode's double effect run.
 *
 * These tests simulate the App's lifecycle (prune on every loaded-tables change,
 * derive the checked set, toggle) via the pure helpers.
 */

import { describe, expect, it } from "vitest";
import {
  selectedTableNames,
  pruneUnchecked,
  toggleUnchecked,
} from "./table-selection";

/** Simulate one "tables changed" step: prune, then derive the checked names. */
function step(
  unchecked: ReadonlySet<string>,
  loadedNames: readonly string[]
): { unchecked: ReadonlySet<string>; checked: Set<string> } {
  const prunedUnchecked = pruneUnchecked(unchecked, loadedNames);
  return {
    unchecked: prunedUnchecked,
    checked: selectedTableNames(loadedNames, prunedUnchecked),
  };
}

describe("table-selection", () => {
  it("leaves all tables checked after an initial load (the bug: they were unchecked)", () => {
    const after = step(new Set(), ["monsters", "experiments", "lab_inventory"]);
    expect([...after.checked].sort()).toEqual([
      "experiments",
      "lab_inventory",
      "monsters",
    ]);
  });

  it("keeps everything checked across a SECOND load (new tables default checked)", () => {
    // First load (e.g. the mismatched demo: two tables).
    let state = step(new Set(), ["monsters", "experiments"]);
    expect([...state.checked].sort()).toEqual(["experiments", "monsters"]);

    // Second load adds more tables (e.g. the three-file demo). The earlier
    // tables stay checked and the new ones are checked by default.
    state = step(state.unchecked, [
      "monsters",
      "experiments",
      "monsters_2",
      "experiments_2",
      "lab_inventory",
    ]);
    expect(state.checked.size).toBe(5);
    expect(state.checked.has("lab_inventory")).toBe(true);
    expect(state.checked.has("monsters_2")).toBe(true);
  });

  it("preserves an explicit uncheck across a later load", () => {
    // Load two tables, all checked.
    let state = step(new Set(), ["monsters", "experiments"]);
    // User unchecks `experiments`.
    const unchecked = toggleUnchecked(state.unchecked, "experiments", false);
    state = step(unchecked, ["monsters", "experiments"]);
    expect(state.checked.has("experiments")).toBe(false);
    expect(state.checked.has("monsters")).toBe(true);

    // A later load adds a new table. The explicit uncheck MUST survive, and the
    // new table is checked by default.
    state = step(state.unchecked, [
      "monsters",
      "experiments",
      "lab_inventory",
    ]);
    expect(state.checked.has("experiments")).toBe(false); // uncheck preserved
    expect(state.checked.has("monsters")).toBe(true);
    expect(state.checked.has("lab_inventory")).toBe(true); // new → checked
  });

  it("re-checks a table that was unchecked, removed, then reloaded", () => {
    let state = step(new Set(), ["monsters", "experiments"]);
    // Uncheck experiments.
    state = step(
      toggleUnchecked(state.unchecked, "experiments", false),
      ["monsters", "experiments"]
    );
    expect(state.checked.has("experiments")).toBe(false);

    // experiments is removed (no longer loaded) → pruned from the unchecked set.
    state = step(state.unchecked, ["monsters"]);
    expect(state.unchecked.has("experiments")).toBe(false);

    // Reloading experiments brings it back CHECKED (its uncheck was forgotten).
    state = step(state.unchecked, ["monsters", "experiments"]);
    expect(state.checked.has("experiments")).toBe(true);
  });

  it("toggleUnchecked adds on uncheck and removes on check", () => {
    const a = toggleUnchecked(new Set(), "monsters", false);
    expect(a.has("monsters")).toBe(true);
    const b = toggleUnchecked(a, "monsters", true);
    expect(b.has("monsters")).toBe(false);
  });

  it("pruneUnchecked returns the same reference when nothing changed", () => {
    const u = new Set(["experiments"]);
    expect(pruneUnchecked(u, ["monsters", "experiments"])).toBe(u);
  });
});
