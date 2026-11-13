/**
 * Pure SQL builders for the Autopsy engine (Feature 4).
 *
 * Every builder returns a read-only SELECT. Table and column identifiers are
 * quoted with the shared `quoteIdent`; column aliases are GENERATED from the
 * column index (`nn3`, `d3`, ...) and never derived from data. The only values
 * ever interpolated are finite numbers formatted by {@link numLit} from
 * computed statistics, so a hostile table or column name stays an inert
 * identifier (Requirement 7.2, 7.3).
 */

import type { ColumnSchema } from "../types.js";
import { quoteIdent } from "../stitching/sql-escape.js";

/**
 * Format a finite number as a SQL numeric literal. Throws a RangeError for NaN
 * or an infinity so a bad statistic can never become SQL text; the engine
 * catches it and reports a friendly error.
 */
export function numLit(x: number): string {
  if (!Number.isFinite(x)) {
    throw new RangeError(`numLit requires a finite number, got ${String(x)}`);
  }
  return String(x);
}

/** Whitespace-normalized form of a column: trim, then collapse whitespace runs. */
function norm(ident: string): string {
  return (
    `regexp_replace(regexp_replace(${ident}, '^\\s+|\\s+$', '', 'g'), '\\s+', ' ', 'g')`
  );
}

/**
 * Stage A: ONE aggregate pass over the whole table. Always selects the row
 * count `n`; per column `nn{i}` (non-null count) and `d{i}` (non-null distinct
 * count); per number column `mn/mx/av/md/q1_/q3_{i}`; per date column
 * `mn/mx{i}` (raw), and `av/md{i}` in epoch seconds.
 */
export function buildStageASql(
  tableName: string,
  schema: readonly ColumnSchema[]
): string {
  const parts: string[] = ["COUNT(*) AS n"];
  schema.forEach((col, i) => {
    const c = quoteIdent(col.name);
    parts.push(`COUNT(${c}) AS nn${i}`, `COUNT(DISTINCT ${c}) AS d${i}`);
    if (col.type === "number") {
      parts.push(
        `CAST(MIN(${c}) AS DOUBLE) AS mn${i}`,
        `CAST(MAX(${c}) AS DOUBLE) AS mx${i}`,
        `CAST(AVG(${c}) AS DOUBLE) AS av${i}`,
        `CAST(quantile_cont(${c}, 0.5) AS DOUBLE) AS md${i}`,
        `CAST(quantile_cont(${c}, 0.25) AS DOUBLE) AS q1_${i}`,
        `CAST(quantile_cont(${c}, 0.75) AS DOUBLE) AS q3_${i}`
      );
    } else if (col.type === "date") {
      parts.push(
        `MIN(${c}) AS mn${i}`,
        `MAX(${c}) AS mx${i}`,
        `CAST(AVG(epoch(${c})) AS DOUBLE) AS av${i}`,
        `CAST(quantile_cont(epoch(${c}), 0.5) AS DOUBLE) AS md${i}`
      );
    }
  });
  return `SELECT ${parts.join(", ")} FROM ${quoteIdent(tableName)}`;
}

/** Exact duplicate rows: row count minus distinct whole rows (NULLs equal). */
export function buildDuplicatesSql(tableName: string): string {
  const t = quoteIdent(tableName);
  return (
    `SELECT COUNT(*) - (SELECT COUNT(*) FROM (SELECT DISTINCT * FROM ${t})) ` +
    `AS dups FROM ${t}`
  );
}

/** Most frequent values, ordered by count desc then value asc (as SampleReader). */
export function buildTopValuesSql(
  tableName: string,
  columnName: string,
  limit: number
): string {
  const c = quoteIdent(columnName);
  const safeLimit = Math.max(0, Math.trunc(limit));
  return (
    `SELECT CAST(${c} AS VARCHAR) AS v, COUNT(*) AS c ` +
    `FROM ${quoteIdent(tableName)} WHERE ${c} IS NOT NULL ` +
    `GROUP BY ${c} ORDER BY c DESC, v ASC LIMIT ${safeLimit}`
  );
}

/**
 * String variants: `ws` = rows differing from their whitespace-normalized form;
 * `cg` = groups of values that differ only by letter case.
 */
export function buildStringVariantsSql(
  tableName: string,
  columnName: string
): string {
  const t = quoteIdent(tableName);
  const c = quoteIdent(columnName);
  return (
    `SELECT ` +
    `(SELECT COUNT(*) FROM ${t} WHERE ${c} IS NOT NULL AND ${c} <> ${norm(c)}) AS ws, ` +
    `(SELECT COUNT(*) FROM (SELECT 1 FROM ${t} WHERE ${c} IS NOT NULL ` +
    `GROUP BY LOWER(${norm(c)}) HAVING COUNT(DISTINCT ${norm(c)}) > 1)) AS cg`
  );
}

/** Count of values outside the fences [lower, upper]. */
export function buildOutlierCountSql(
  tableName: string,
  columnName: string,
  lower: number,
  upper: number
): string {
  const c = quoteIdent(columnName);
  return (
    `SELECT COUNT(*) AS oc FROM ${quoteIdent(tableName)} ` +
    `WHERE ${c} < ${numLit(lower)} OR ${c} > ${numLit(upper)}`
  );
}

/** Outlier examples: the values farthest from the median first. */
export function buildOutlierExamplesSql(
  tableName: string,
  columnName: string,
  lower: number,
  upper: number,
  median: number,
  limit: number
): string {
  const c = quoteIdent(columnName);
  const safeLimit = Math.max(0, Math.trunc(limit));
  return (
    `SELECT CAST(${c} AS DOUBLE) AS v FROM ${quoteIdent(tableName)} ` +
    `WHERE ${c} < ${numLit(lower)} OR ${c} > ${numLit(upper)} ` +
    `ORDER BY ABS(${c} - ${numLit(median)}) DESC, ${c} ASC LIMIT ${safeLimit}`
  );
}
