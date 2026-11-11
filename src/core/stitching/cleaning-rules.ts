/**
 * Deterministic cleaning rules for the stitching engine (Feature 2, task 7).
 *
 * Pure, framework-agnostic rule logic that turns the per-table
 * {@link TableSample}s produced by the SampleReader (task 4) into
 * {@link CleaningProposal}s (Req 2.1–2.8). The only non-pure dependency is a
 * read-only {@link DuckDBService} used to count duplicate rows and outliers
 * over the FULL column (see "Cleaning rules" in the design): the bounded
 * samples surface *which* columns have something to clean, but the before/after
 * counts for duplicates and outliers are computed in SQL over the whole table
 * so they are not skewed by the ≤200 distinct-sample cap.
 *
 * ## The four cleaning kinds (design: "Cleaning rules")
 *
 * - **whitespace** — trim leading/trailing whitespace and collapse internal
 *   runs of whitespace to a single space. Never changes letter case. Proposed
 *   for a text column when at least one sampled value is not already
 *   whitespace-normalized. Idempotent: re-trimming trimmed text is a no-op.
 * - **case** (also `whitespace-case` kind) — offered *only* when the same value
 *   appears with differing casing in the column (e.g. `"swamp wraith"` and
 *   `"Swamp Wraith"` both present). The target is the **most frequent surface
 *   form** among those casings (ties → lexicographically smallest). A value
 *   whose casing is unique is left untouched. Idempotent by construction.
 * - **category-standardize** — fold each value (lowercase, trim+collapse
 *   whitespace, punctuation→space, collapse again), cluster by equal folded
 *   form, optionally merge clusters whose folded representatives have
 *   normalized-Levenshtein similarity ≥ 0.9, pick each cluster's canonical as
 *   its most frequent surface form (ties → smallest), and build a `variantMap`.
 *   Idempotent: every canonical folds to itself and maps to itself.
 * - **duplicate-rows** — flag when fully-identical rows (after the whitespace/
 *   case normalization above applied to text cells) occur more than once. The
 *   before/after row counts come from SQL over the full table.
 * - **outliers** (number columns only) — flag values outside the Tukey fences
 *   `[Q1 − 1.5·IQR, Q3 + 1.5·IQR]`, with the fences and the outlier count
 *   computed in SQL over the full column via `quantile_cont` (the same fences
 *   the apply step uses).
 *
 * Every proposal carries a before/after representation and a one-line plain-text
 * reason (Req 2.7), and every transform is idempotent by construction (Req 2.8).
 */

import type { ColumnSchema, DuckDBService } from "../types";
import { levenshtein } from "./name-similarity";
import { quoteIdent } from "./sql-escape";
import {
  type CleaningProposal,
  type SampleValue,
  type TableSample,
} from "./types";

/**
 * Normalized-Levenshtein similarity threshold at or above which two folded
 * category representatives are merged into one cluster (design: "category-
 * standardize", step 3 — catches single-character typos like
 * `wraith`/`wriath`).
 */
export const CATEGORY_MERGE_SIMILARITY = 0.9;

/**
 * Maximum distinct non-null sampled values for a text column to be treated as a
 * *category* column eligible for `category-standardize`. Above this a column is
 * free text, not a small enumerated domain, so standardization would be noise.
 * (The samples are already bounded to ≤200 by the SampleReader; this is a
 * tighter cardinality gate for the category rule specifically.)
 */
export const CATEGORY_MAX_DISTINCT = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Pure string helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whitespace normalization used by the `whitespace` rule and by duplicate-row
 * detection: trim ends and collapse internal whitespace runs to a single space.
 * Never changes case. Idempotent.
 */
export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * Fold a value for category clustering (design: "category-standardize", step
 * 1): lowercase, trim+collapse whitespace, replace punctuation (anything that
 * is not a letter, digit, or space) with a space, then collapse whitespace
 * again. Pure and idempotent on its own output.
 */
export function foldCategory(value: string): string {
  const lowered = value.normalize("NFKC").toLowerCase();
  // Punctuation (incl. `-`, `_`) → space, then collapse + trim.
  const spaced = lowered.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  return spaced.trim().replace(/\s+/gu, " ");
}

/**
 * Normalized-Levenshtein similarity in [0, 1] over two strings:
 * `1 − dist / max(len)`. Both empty → 1. Reuses the shared {@link levenshtein}.
 */
export function normalizedLevenshtein(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) {
    return 1;
  }
  return 1 - levenshtein(a, b) / longest;
}

/** A sampled value guaranteed non-null (a real cleaning value). */
export interface NonNullSample {
  value: string;
  count: number;
}

/** Non-null string sample values only (nulls are not cleaning values). */
function nonNullSamples(samples: SampleValue[]): NonNullSample[] {
  return samples.filter((s): s is NonNullSample => s.value !== null);
}

/**
 * Pick the most frequent surface form from a list of (value, count) entries,
 * breaking ties by the lexicographically smallest value (the global tie-break).
 * Assumes a non-empty list.
 */
function mostFrequentSurfaceForm(
  entries: NonNullSample[]
): string {
  let best = entries[0];
  for (const entry of entries) {
    if (
      entry.count > best.count ||
      (entry.count === best.count && entry.value < best.value)
    ) {
      best = entry;
    }
  }
  return best.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// whitespace + case (Req 2.1, 2.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the whitespace proposal for a text column, if any sampled value is not
 * already whitespace-normalized. The `after` is the trimmed/collapsed form of a
 * representative offending value.
 */
function buildWhitespaceProposal(
  tableName: string,
  column: ColumnSchema,
  samples: NonNullSample[]
): CleaningProposal | null {
  const offending = samples.find(
    (s) => normalizeWhitespace(s.value) !== s.value
  );
  if (!offending) {
    return null;
  }
  const before = offending.value;
  const after = normalizeWhitespace(before);
  return {
    id: `clean:whitespace:${tableName}.${column.name}`,
    target: { tableName, columnName: column.name },
    kind: "whitespace-case",
    before,
    after,
    reason: `Trim and collapse whitespace in "${tableName}.${column.name}" (e.g. "${before}" → "${after}").`,
  };
}

/**
 * Build the case proposal for a text column, if the same value appears with
 * differing casing. Values are grouped by their lowercased form; a group with
 * more than one distinct surface casing yields a standardization to the most
 * frequent surface form (ties → smallest). The `variantMap` maps every differing
 * casing to its chosen canonical.
 */
function buildCaseProposal(
  tableName: string,
  column: ColumnSchema,
  samples: NonNullSample[]
): CleaningProposal | null {
  // Group by lowercased surface so differing-casing variants collide.
  const groups = new Map<string, NonNullSample[]>();
  for (const sample of samples) {
    const key = sample.value.toLowerCase();
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(sample);
    } else {
      groups.set(key, [sample]);
    }
  }

  const variantMap: Record<string, string> = {};
  let exampleBefore: string | null = null;
  let exampleAfter: string | null = null;

  // Deterministic order: iterate groups by their (sorted) keys.
  for (const key of [...groups.keys()].sort()) {
    const bucket = groups.get(key)!;
    const distinctForms = new Set(bucket.map((b) => b.value));
    if (distinctForms.size <= 1) {
      continue; // casing is unique → leave untouched.
    }
    const canonical = mostFrequentSurfaceForm(bucket);
    for (const form of [...distinctForms].sort()) {
      if (form !== canonical) {
        variantMap[form] = canonical;
        if (exampleBefore === null) {
          exampleBefore = form;
          exampleAfter = canonical;
        }
      }
    }
  }

  if (Object.keys(variantMap).length === 0) {
    return null;
  }

  return {
    id: `clean:case:${tableName}.${column.name}`,
    target: { tableName, columnName: column.name },
    kind: "whitespace-case",
    before: exampleBefore,
    after: exampleAfter,
    reason: `Standardize inconsistent casing in "${tableName}.${column.name}" to the most frequent form (e.g. "${exampleBefore}" → "${exampleAfter}").`,
    canonical: exampleAfter ?? undefined,
    variantMap,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// category-standardize (Req 2.2, 2.8)
// ─────────────────────────────────────────────────────────────────────────────

interface CategoryCluster {
  /** The folded representative (used for inter-cluster near-dup merging). */
  folded: string;
  /** Surface forms (value + count) that fell into this cluster. */
  members: NonNullSample[];
}

/**
 * Cluster a text column's distinct sampled values into category clusters
 * (design: "category-standardize"): exact folded-form clustering, then an
 * optional near-duplicate merge of clusters whose folded representatives are
 * ≥ {@link CATEGORY_MERGE_SIMILARITY} similar. Fully deterministic: clusters
 * are processed in a fixed (folded-ascending) order.
 */
export function clusterCategories(
  samples: NonNullSample[]
): CategoryCluster[] {
  // 1–2. Cluster by equal folded form.
  const byFolded = new Map<string, NonNullSample[]>();
  for (const sample of samples) {
    const folded = foldCategory(sample.value);
    if (folded.length === 0) {
      continue; // nothing left after folding (e.g. punctuation-only).
    }
    const bucket = byFolded.get(folded);
    if (bucket) {
      bucket.push(sample);
    } else {
      byFolded.set(folded, [sample]);
    }
  }

  // Fixed order: folded representatives ascending.
  const clusters: CategoryCluster[] = [...byFolded.keys()]
    .sort()
    .map((folded) => ({ folded, members: byFolded.get(folded)! }));

  // 3. Optional near-duplicate merge. Union-find over cluster indices, merging
  //    a later cluster into the earliest sufficiently-similar earlier cluster.
  const parent = clusters.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      if (
        normalizedLevenshtein(clusters[i].folded, clusters[j].folded) >=
        CATEGORY_MERGE_SIMILARITY
      ) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
          // Attach the larger-index root under the smaller so the earliest
          // (smallest folded) representative stays the group root.
          parent[Math.max(rootI, rootJ)] = Math.min(rootI, rootJ);
        }
      }
    }
  }

  // Collect merged clusters by their root, preserving root order.
  const merged = new Map<number, CategoryCluster>();
  for (let i = 0; i < clusters.length; i += 1) {
    const root = find(i);
    const existing = merged.get(root);
    if (existing) {
      existing.members.push(...clusters[i].members);
    } else {
      merged.set(root, {
        folded: clusters[root].folded,
        members: [...clusters[i].members],
      });
    }
  }

  return [...merged.values()];
}

/**
 * Build the category-standardize proposal for a text column, if at least one
 * cluster has more than one distinct surface form (i.e. there is something to
 * standardize). The default `canonical` is reported for the diff; `variantMap`
 * maps every variant → its cluster canonical.
 */
function buildCategoryProposal(
  tableName: string,
  column: ColumnSchema,
  samples: NonNullSample[]
): CleaningProposal | null {
  const distinctValues = new Set(samples.map((s) => s.value));
  if (distinctValues.size > CATEGORY_MAX_DISTINCT) {
    return null; // free text, not a small category domain.
  }

  const clusters = clusterCategories(samples);

  const variantMap: Record<string, string> = {};
  let exampleBefore: string | null = null;
  let exampleCanonical: string | null = null;

  for (const cluster of clusters) {
    const distinctForms = [...new Set(cluster.members.map((m) => m.value))];
    if (distinctForms.length <= 1) {
      continue; // single surface form → nothing to standardize.
    }
    // Canonicalize to the most-frequent surface form, then whitespace-normalize
    // it. The canonical MUST be a fixed point of the whitespace rule: a column
    // can carry BOTH a whitespace proposal and this category proposal, and the
    // apply step composes them as category(whitespace(value)). If the canonical
    // kept stray/internal whitespace, a second apply would re-trim it and the
    // (raw-keyed) category map would no longer match, breaking idempotence
    // (Property 4 / Req 2.8). Normalizing the canonical here keeps the whole
    // composed transform idempotent by construction.
    const canonical = normalizeWhitespace(
      mostFrequentSurfaceForm(cluster.members)
    );
    for (const form of distinctForms.sort()) {
      // Key the map on the whitespace-normalized surface form so the lookup
      // still fires after the whitespace step has run (and so the canonical
      // maps to itself as a fixed point). Raw and normalized forms that collapse
      // to the same key simply share one entry.
      variantMap[normalizeWhitespace(form)] = canonical;
      if (form !== canonical && exampleBefore === null) {
        exampleBefore = form;
        exampleCanonical = canonical;
      }
    }
  }

  if (exampleBefore === null || exampleCanonical === null) {
    return null;
  }

  return {
    id: `clean:category:${tableName}.${column.name}`,
    target: { tableName, columnName: column.name },
    kind: "category-standardize",
    before: exampleBefore,
    after: exampleCanonical,
    reason: `Standardize category values in "${tableName}.${column.name}" (e.g. "${exampleBefore}" → "${exampleCanonical}").`,
    canonical: exampleCanonical,
    variantMap,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// duplicate-rows (Req 2.3, 2.4) — counted in SQL over the full table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A DuckDB expression that normalizes a cell for duplicate detection: text
 * columns are trimmed + whitespace-collapsed (matching {@link normalizeWhitespace});
 * non-text columns are compared as-is (cast to VARCHAR for a stable, null-safe
 * key). NULLs are coalesced to a sentinel so two NULLs compare equal.
 */
function duplicateKeyExpr(column: ColumnSchema): string {
  const ident = quoteIdent(column.name);
  // Sentinel for NULL cells so two NULLs compare equal. A literal NUL byte
  // crashes the DuckDB-WASM MVP bundle, so use a printable, highly-unlikely
  // marker (an exact collision with a real value only loses one spurious
  // "duplicate", never corrupts data).
  const nullSentinel = `'\u2400NULL\u2400'`;
  if (column.type === "string") {
    // trim + collapse internal whitespace, matching normalizeWhitespace.
    const collapsed = `regexp_replace(trim(${ident}), '\\s+', ' ', 'g')`;
    return `coalesce(${collapsed}, ${nullSentinel})`;
  }
  return `coalesce(CAST(${ident} AS VARCHAR), ${nullSentinel})`;
}

/**
 * Count duplicate rows (rows beyond the first in each normalized-identical
 * group) over the FULL table via SQL. Returns the total row count and the
 * number of rows that keep-first dedupe would remove.
 *
 * The distinct-normalized count is taken from `SELECT COUNT(*) FROM (SELECT
 * DISTINCT <normalized key exprs> FROM t)` rather than `COUNT(DISTINCT
 * (composite))`: the composite / expression form of `COUNT(DISTINCT ...)` (and
 * grouping directly on a `regexp_replace` key) crashes the DuckDB-WASM MVP
 * bundle, whereas projecting the normalized keys and counting the distinct
 * projection is stable and equivalent.
 */
async function countDuplicateRows(
  db: DuckDBService,
  table: TableSample
): Promise<{ totalRows: number; duplicateRows: number }> {
  if (table.schema.length === 0) {
    return { totalRows: table.rowCount, duplicateRows: 0 };
  }
  const keys = table.schema
    .map((c, i) => `${duplicateKeyExpr(c)} AS k${i}`)
    .join(", ");
  const tableIdent = quoteIdent(table.tableName);
  // total rows, and distinct normalized rows; duplicates = total − distinct.
  const sql =
    `SELECT COUNT(*) AS total, ` +
    `COUNT(*) - (SELECT COUNT(*) FROM (SELECT DISTINCT ${keys} FROM ${tableIdent})) AS dups ` +
    `FROM ${tableIdent}`;
  const rows = await db.query<{ total: number | bigint; dups: number | bigint }>(
    sql
  );
  const row = rows[0] ?? { total: 0, dups: 0 };
  return {
    totalRows: Number(row.total),
    duplicateRows: Number(row.dups),
  };
}

/**
 * Build the duplicate-rows proposal, if any fully-identical (normalized) rows
 * occur more than once. The before/after counts come from the full-table SQL.
 */
async function buildDuplicateProposal(
  db: DuckDBService,
  table: TableSample
): Promise<CleaningProposal | null> {
  const { totalRows, duplicateRows } = await countDuplicateRows(db, table);
  if (duplicateRows <= 0) {
    return null;
  }
  const after = totalRows - duplicateRows;
  return {
    id: `clean:duplicate-rows:${table.tableName}`,
    target: { tableName: table.tableName },
    kind: "duplicate-rows",
    before: { rowCount: totalRows },
    after: { rowCount: after },
    reason: `Remove ${duplicateRows} duplicate row${duplicateRows === 1 ? "" : "s"} from "${table.tableName}" (${totalRows} → ${after} rows), keeping the first of each.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// outliers (Req 2.5, 2.6) — number columns only, counted in SQL over the column
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count outliers in a number column over the FULL column using the Tukey
 * fences `[Q1 − 1.5·IQR, Q3 + 1.5·IQR]` with `quantile_cont` (the same fences
 * the apply step uses). Returns the non-null row count and the outlier count.
 */
async function countOutliers(
  db: DuckDBService,
  tableName: string,
  columnName: string
): Promise<{ nonNull: number; outliers: number }> {
  const col = quoteIdent(columnName);
  const tableIdent = quoteIdent(tableName);
  const sql =
    `WITH q AS (` +
    `SELECT quantile_cont(${col}, 0.25) AS q1, ` +
    `quantile_cont(${col}, 0.75) AS q3 ` +
    `FROM ${tableIdent} WHERE ${col} IS NOT NULL` +
    `) ` +
    `SELECT COUNT(*) AS non_null, ` +
    `COUNT(*) FILTER (` +
    `WHERE ${col} < q.q1 - 1.5 * (q.q3 - q.q1) ` +
    `OR ${col} > q.q3 + 1.5 * (q.q3 - q.q1)` +
    `) AS outliers ` +
    `FROM ${tableIdent}, q WHERE ${col} IS NOT NULL`;
  const rows = await db.query<{
    non_null: number | bigint;
    outliers: number | bigint;
  }>(sql);
  const row = rows[0] ?? { non_null: 0, outliers: 0 };
  return {
    nonNull: Number(row.non_null),
    outliers: Number(row.outliers),
  };
}

/**
 * Build the outlier proposal for a number column, if the full-column Tukey
 * fences flag at least one value. Approving adds an `is_outlier` column and
 * removes no rows, so before/after are expressed as the flagged count.
 */
async function buildOutlierProposal(
  db: DuckDBService,
  tableName: string,
  column: ColumnSchema
): Promise<CleaningProposal | null> {
  const { nonNull, outliers } = await countOutliers(
    db,
    tableName,
    column.name
  );
  if (outliers <= 0) {
    return null;
  }
  return {
    id: `clean:outliers:${tableName}.${column.name}`,
    target: { tableName, columnName: column.name },
    kind: "outliers",
    before: { outliersFlagged: 0, nonNull },
    after: { outliersFlagged: outliers, nonNull },
    reason: `Flag ${outliers} outlier value${outliers === 1 ? "" : "s"} in "${tableName}.${column.name}" (Tukey fences); adds an is_outlier column, removes no rows.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce all {@link CleaningProposal}s for the given tables (Req 2.1–2.8).
 *
 * Deterministic for fixed input: tables and columns are visited in input order,
 * all internal ordering/tie-breaks are lexicographic, and the SQL counts are
 * stable aggregates over the full tables. Proposals are emitted in a fixed
 * per-column order (whitespace, case, category, outliers) followed by the
 * per-table duplicate-rows proposal.
 *
 * @param db      read-only DuckDB access for the full-column duplicate/outlier
 *                counts (the only non-pure dependency).
 * @param tables  the per-table bounded samples from the SampleReader.
 */
export async function cleanTables(
  db: DuckDBService,
  tables: TableSample[]
): Promise<CleaningProposal[]> {
  const proposals: CleaningProposal[] = [];

  for (const table of tables) {
    for (const column of table.schema) {
      const samples = nonNullSamples(table.samplesByColumn[column.name] ?? []);

      if (column.type === "string") {
        if (samples.length > 0) {
          const whitespace = buildWhitespaceProposal(
            table.tableName,
            column,
            samples
          );
          if (whitespace) {
            proposals.push(whitespace);
          }
          const caseProposal = buildCaseProposal(
            table.tableName,
            column,
            samples
          );
          if (caseProposal) {
            proposals.push(caseProposal);
          }
          const category = buildCategoryProposal(
            table.tableName,
            column,
            samples
          );
          if (category) {
            proposals.push(category);
          }
        }
      } else if (column.type === "number") {
        const outlier = await buildOutlierProposal(
          db,
          table.tableName,
          column
        );
        if (outlier) {
          proposals.push(outlier);
        }
      }
    }

    const duplicate = await buildDuplicateProposal(db, table);
    if (duplicate) {
      proposals.push(duplicate);
    }
  }

  return proposals;
}
