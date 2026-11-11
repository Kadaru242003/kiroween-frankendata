/**
 * Pure helpers for the "Tables to stitch" selection model (fix batch, item 1).
 *
 * The selection is modeled by the set of table names the user has EXPLICITLY
 * UNCHECKED. A table is CHECKED iff it is currently loaded and NOT in that set,
 * so "all tables checked by default, including ones loaded later" is simply the
 * zero-state (an empty unchecked set) — with no per-arrival bookkeeping. That
 * makes it robust under React StrictMode's double effect invocation, which was
 * the bug in the earlier "seen"-set approach (a freshly loaded table could end
 * up unchecked).
 *
 * These are framework-agnostic so they can be unit-tested without the DuckDB /
 * React app stack.
 */

/**
 * The set of CHECKED table names: every loaded name that is not explicitly
 * unchecked. Preserves the loaded order is irrelevant (it returns a Set).
 */
export function selectedTableNames(
  loadedNames: readonly string[],
  unchecked: ReadonlySet<string>
): Set<string> {
  return new Set(loadedNames.filter((name) => !unchecked.has(name)));
}

/**
 * Drop unchecked entries whose table is no longer loaded (so a removed-then-
 * reloaded table comes back checked). Returns the SAME set reference when
 * nothing changed, so callers can skip a state update.
 */
export function pruneUnchecked(
  unchecked: ReadonlySet<string>,
  loadedNames: readonly string[]
): ReadonlySet<string> {
  const loaded = new Set(loadedNames);
  let changed = false;
  const next = new Set<string>();
  for (const name of unchecked) {
    if (loaded.has(name)) {
      next.add(name);
    } else {
      changed = true;
    }
  }
  return changed ? next : unchecked;
}

/**
 * Apply a checkbox toggle to the unchecked set: checking removes the name,
 * unchecking adds it.
 */
export function toggleUnchecked(
  unchecked: ReadonlySet<string>,
  tableName: string,
  checked: boolean
): Set<string> {
  const next = new Set(unchecked);
  if (checked) {
    next.delete(tableName);
  } else {
    next.add(tableName);
  }
  return next;
}
