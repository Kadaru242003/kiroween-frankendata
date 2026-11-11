/**
 * The deterministic {@link RulesEngine} (Feature 2).
 *
 * Stateless, pure, framework-agnostic matching and cleaning over
 * `(tables: TableSample[])`. Identical input always produces identical output
 * (Req 5.2). This module hosts the engine factory; the matching algorithm
 * lives in {@link matchTables} (task 6) and the cleaning algorithm lives in
 * {@link cleanTables} (task 7).
 */

import { cleanTables } from "./cleaning-rules";
import { matchTables } from "./match-scoring";
import type { DuckDBService } from "../types";
import type {
  CleaningProposal,
  MatchProposal,
  RulesEngine,
  TableSample,
} from "./types";

/**
 * Create the deterministic rules engine.
 *
 * `match` scores every unordered cross-table column pair, applies the hard
 * gates, and returns symmetric, deduplicated {@link MatchProposal}s at or above
 * the display threshold (task 6). It is pure over its `tables` argument.
 *
 * `clean` produces {@link CleaningProposal}s (task 7). Whitespace/case and
 * category-standardize proposals are derived purely from the bounded samples;
 * the duplicate-rows and number-column outlier proposals carry before/after
 * counts computed in SQL over the FULL table (using the same `quantile_cont`
 * Tukey fences as apply), so `clean` needs the injected read-only
 * {@link DuckDBService} and is async.
 *
 * @param db  read-only DuckDB access used only by `clean` for the full-column
 *            duplicate/outlier counts.
 */
export function createRulesEngine(db: DuckDBService): RulesEngine {
  function match(tables: TableSample[]): MatchProposal[] {
    return matchTables(tables);
  }

  function matchAll(tables: TableSample[]): MatchProposal[] {
    // displayOnly = false → the full scored set (incl. sub-threshold matches
    // that passed the hard gates), for the AI's wider candidate floor.
    return matchTables(tables, false);
  }

  function clean(tables: TableSample[]): Promise<CleaningProposal[]> {
    return cleanTables(db, tables);
  }

  return { match, matchAll, clean };
}
