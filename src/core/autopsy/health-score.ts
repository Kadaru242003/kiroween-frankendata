/**
 * Health score and column status for the Autopsy (Feature 4).
 *
 * Pure and framework-agnostic. The score starts at 100 and subtracts a bounded
 * number of points per problem category; every non-zero deduction is returned
 * in a breakdown with a plain-text reason so the score is fully transparent
 * (Requirement 4). Inputs are sanitized, so any numbers (even NaN or negatives)
 * still yield an integer score between 0 and 100.
 */

import {
  AUTOPSY_NULL_CRIT_PCT,
  AUTOPSY_NULL_WARN_PCT,
  AUTOPSY_OUTLIER_CRIT_PCT,
  type ColumnFinding,
  type ColumnStatus,
  type HealthDeduction,
  type HealthResult,
} from "./types.js";

/** The per-column facts the score needs. */
export type HealthColumn = Pick<
  ColumnFinding,
  "nullPct" | "whitespaceRows" | "caseVariantGroups" | "categoryVariants" | "outliers"
>;

export interface HealthInput {
  rows: number;
  duplicateRows: number;
  columns: readonly HealthColumn[];
  allNullColumns: number;
  constantColumns: number;
}

/** Coerce to a finite, non-negative number (NaN and infinities become 0). */
function clean(x: number | undefined): number {
  return typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Compute the HealthScore (integer 0 to 100) and its transparent breakdown. */
export function computeHealth(input: HealthInput): HealthResult {
  const rows = clean(input.rows);
  const duplicateRows = Math.min(clean(input.duplicateRows), rows);
  const breakdown: HealthDeduction[] = [];

  const add = (code: string, reason: string, points: number): void => {
    const p = Math.trunc(points);
    if (p > 0) {
      breakdown.push({ code, reason, points: p });
    }
  };

  // duplicates: 1 point per percent of duplicate rows, capped at 20.
  const dupPct = rows > 0 ? (100 * duplicateRows) / rows : 0;
  add(
    "duplicates",
    `${dupPct.toFixed(1)}% of rows are exact duplicates (${duplicateRows} of ${rows})`,
    Math.min(20, Math.round(dupPct))
  );

  // nulls: half a point per percent of mean null density, capped at 25.
  const cols = input.columns;
  const meanNull =
    cols.length > 0
      ? cols.reduce((s, c) => s + Math.min(100, clean(c.nullPct)), 0) / cols.length
      : 0;
  add(
    "nulls",
    `Columns average ${meanNull.toFixed(1)}% missing values`,
    Math.min(25, Math.round(0.5 * meanNull))
  );

  const allNull = Math.trunc(clean(input.allNullColumns));
  add(
    "all-null",
    `${plural(allNull, "column is", "columns are")} entirely empty`,
    Math.min(15, 5 * allNull)
  );

  const constant = Math.trunc(clean(input.constantColumns));
  add(
    "constant",
    `${plural(constant, "column has", "columns have")} a single repeated value`,
    Math.min(6, 2 * constant)
  );

  const ws = cols.filter((c) => clean(c.whitespaceRows) > 0).length;
  add(
    "whitespace",
    `${plural(ws, "column has", "columns have")} stray or repeated whitespace`,
    Math.min(10, 2 * ws)
  );

  const variants = cols.filter(
    (c) => clean(c.caseVariantGroups) > 0 || clean(c.categoryVariants) > 0
  ).length;
  add(
    "variants",
    `${plural(variants, "column has", "columns have")} casing or category variants`,
    Math.min(15, 3 * variants)
  );

  const outliers = cols.filter((c) => clean(c.outliers?.count) > 0).length;
  add(
    "outliers",
    `${plural(outliers, "numeric column has", "numeric columns have")} outliers`,
    Math.min(10, 2 * outliers)
  );

  const total = breakdown.reduce((s, d) => s + d.points, 0);
  return { score: Math.max(0, 100 - total), breakdown };
}

/** The facts needed to assign a column's status. */
export type StatusInput = Pick<
  ColumnFinding,
  | "rows"
  | "nullCount"
  | "nullPct"
  | "distinct"
  | "whitespaceRows"
  | "caseVariantGroups"
  | "categoryVariants"
  | "outliers"
>;

/**
 * Assign a ColumnStatus using the defined thresholds (Requirement 4.4), with a
 * plain-text reason for each condition that applied.
 */
export function columnStatus(f: StatusInput): {
  status: ColumnStatus;
  reasons: string[];
} {
  const critical: string[] = [];
  const warning: string[] = [];
  const nonNull = Math.max(0, f.rows - f.nullCount);

  const allNull = f.rows > 0 && f.nullCount >= f.rows;
  if (allNull) {
    critical.push("Column is entirely empty");
  } else if (f.nullPct >= AUTOPSY_NULL_CRIT_PCT) {
    critical.push(`${f.nullPct.toFixed(1)}% of values are missing`);
  } else if (f.nullPct >= AUTOPSY_NULL_WARN_PCT) {
    warning.push(`${f.nullPct.toFixed(1)}% of values are missing`);
  }

  const outlierCount = f.outliers?.count ?? 0;
  if (outlierCount > 0) {
    const pct = nonNull > 0 ? (100 * outlierCount) / nonNull : 0;
    if (pct >= AUTOPSY_OUTLIER_CRIT_PCT) {
      critical.push(`${pct.toFixed(1)}% of values are outliers`);
    } else {
      warning.push(`${plural(outlierCount, "outlier", "outliers")} found`);
    }
  }

  if (!allNull && f.distinct === 1 && f.rows >= 2) {
    warning.push("Every value is the same");
  }
  if ((f.whitespaceRows ?? 0) > 0) {
    warning.push(`${plural(f.whitespaceRows ?? 0, "row has", "rows have")} stray whitespace`);
  }
  if ((f.caseVariantGroups ?? 0) > 0) {
    warning.push(
      `${plural(f.caseVariantGroups ?? 0, "group differs", "groups differ")} only by letter case`
    );
  }
  if ((f.categoryVariants ?? 0) > 0) {
    warning.push(`${plural(f.categoryVariants ?? 0, "category variant", "category variants")} found`);
  }

  if (critical.length > 0) {
    return { status: "critical", reasons: [...critical, ...warning] };
  }
  if (warning.length > 0) {
    return { status: "warning", reasons: warning };
  }
  return { status: "healthy", reasons: [] };
}
