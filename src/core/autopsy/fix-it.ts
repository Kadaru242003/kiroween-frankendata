/**
 * Fix it mapping for the Autopsy (Feature 4).
 *
 * A thin mapping over the EXISTING cleaning rules: it reads the target's
 * bounded sample with `createSampleReader` and calls `cleanTables`, then keeps
 * the proposals the report can offer as fixes (whitespace-case,
 * category-standardize, and duplicate-rows). No new proposal kind and no new
 * apply path: each {@link FixAction} carries the existing `CleaningProposal`,
 * whose id (`clean:whitespace:T.col`, `clean:case:T.col`,
 * `clean:category:T.col`, `clean:duplicate-rows:T`) is exactly the id the
 * stitching controller produces for the same table, so the approval flow can
 * accept it as is (Requirement 5).
 *
 * Outlier proposals are not offered: they add an `is_outlier` column and are
 * flags rather than fixes.
 */

import type { DuckDBService } from "../types.js";
import { createSampleReader } from "../stitching/sample-reader.js";
import { cleanTables } from "../stitching/cleaning-rules.js";
import type { CleaningKind, CleaningProposal } from "../stitching/types.js";
import type { AutopsyTarget, FixAction } from "./types.js";

/** The cleaning kinds the Autopsy offers as "Fix it". */
const FIXABLE_KINDS: ReadonlySet<CleaningKind> = new Set<CleaningKind>([
  "whitespace-case",
  "category-standardize",
  "duplicate-rows",
]);

/**
 * Run the existing cleaning rules for one target and return ALL of their
 * proposals for that table (used both for category variant counts and for the
 * fix actions). Rejects if the underlying queries fail; callers catch.
 */
export async function loadCleaningProposals(
  db: DuckDBService,
  target: AutopsyTarget
): Promise<CleaningProposal[]> {
  const reader = createSampleReader(db);
  const sample = await reader.readTable({
    tableName: target.tableName,
    schema: target.schema,
    rowCount: target.rowCount,
  });
  const proposals = await cleanTables(db, [sample]);
  return proposals.filter((p) => p.target.tableName === target.tableName);
}

/** A human label for a proposal, as plain text. */
function labelFor(p: CleaningProposal): string {
  const col = p.target.columnName ?? "";
  if (p.kind === "duplicate-rows") {
    return "Remove duplicate rows";
  }
  if (p.kind === "category-standardize") {
    return `Standardize categories in ${col}`;
  }
  return p.id.startsWith("clean:case:")
    ? `Unify letter case in ${col}`
    : `Trim and collapse whitespace in ${col}`;
}

/** Map existing cleaning proposals to FixActions (fixable kinds only). */
export function toFixActions(proposals: readonly CleaningProposal[]): FixAction[] {
  return proposals
    .filter((p) => FIXABLE_KINDS.has(p.kind))
    .map((p) => ({
      proposalId: p.id,
      kind: p.kind,
      columnName: p.target.columnName,
      label: labelFor(p),
      proposal: p,
    }));
}

/** Convenience: load the existing proposals and map them to FixActions. */
export async function buildFixActions(
  db: DuckDBService,
  target: AutopsyTarget
): Promise<FixAction[]> {
  return toFixActions(await loadCleaningProposals(db, target));
}
