/**
 * The Autopsy engine (Feature 4): a read-only, staged data quality report.
 *
 * {@link runAutopsy} issues only aggregate SELECTs through
 * `DuckDBService.query` (one pass for the table, one query for duplicates, a
 * few small queries per column, then the existing cleaning rules). It reports
 * progress after each stage, never throws, and never modifies any table
 * (Requirement 7). The pure helpers ({@link buildColumnFinding},
 * {@link assembleReport}) turn raw statistics into the report and are tested
 * without DuckDB.
 */

import type { ColumnSchema, DuckDBService } from "../types.js";
import { toDisplayValue } from "../chat/result-convert.js";
import {
  buildDuplicatesSql,
  buildOutlierCountSql,
  buildOutlierExamplesSql,
  buildStageASql,
  buildStringVariantsSql,
  buildTopValuesSql,
} from "./autopsy-sql.js";
import { columnStatus, computeHealth } from "./health-score.js";
import { loadCleaningProposals, toFixActions } from "./fix-it.js";
import {
  AUTOPSY_IQR_FACTOR,
  AUTOPSY_LOW_CARDINALITY_MAX,
  AUTOPSY_MAX_ROWS,
  AUTOPSY_OUTLIER_EXAMPLES,
  AUTOPSY_TOP_VALUES,
  type AutopsyReport,
  type AutopsyTarget,
  type ColumnFinding,
  type FixAction,
  type OutlierFinding,
  type TopValue,
} from "./types.js";

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Raw stage A statistics for one column (already normalized to JS values). */
export interface RawColumnStats {
  nonNull: number;
  distinct: number;
  min?: number | string;
  max?: number | string;
  mean?: number | string;
  median?: number | string;
  /** Number columns only; used for the outlier fences. */
  q1?: number;
  q3?: number;
}

/** Stage B/C details for one column. */
export interface ColumnDetails {
  topValues?: TopValue[];
  whitespaceRows?: number;
  caseVariantGroups?: number;
  categoryVariants?: number;
  outliers?: OutlierFinding;
  detailsUnavailable?: boolean;
}

/** Convert epoch seconds (a date mean or median) to a `YYYY-MM-DD` string. */
export function epochSecondsToIsoDate(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  const d = new Date(Math.floor(seconds / 86400) * 86400 * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Build one ColumnFinding from raw statistics and details (pure). */
export function buildColumnFinding(
  col: ColumnSchema,
  rows: number,
  raw: RawColumnStats,
  details: ColumnDetails = {}
): ColumnFinding {
  const nullCount = Math.max(0, rows - raw.nonNull);
  const nullPct = rows > 0 ? (nullCount / rows) * 100 : 0;
  const finding: ColumnFinding = {
    name: col.name,
    type: col.type,
    rows,
    nullCount,
    nullPct,
    distinct: raw.distinct,
    status: "healthy",
    statusReasons: [],
  };
  if (details.topValues) finding.topValues = details.topValues;
  if (raw.min !== undefined) finding.min = raw.min;
  if (raw.max !== undefined) finding.max = raw.max;
  if (raw.mean !== undefined) finding.mean = raw.mean;
  if (raw.median !== undefined) finding.median = raw.median;
  if (details.whitespaceRows !== undefined) finding.whitespaceRows = details.whitespaceRows;
  if (details.caseVariantGroups !== undefined) finding.caseVariantGroups = details.caseVariantGroups;
  if (details.categoryVariants !== undefined) finding.categoryVariants = details.categoryVariants;
  if (details.outliers) finding.outliers = details.outliers;

  const { status, reasons } = columnStatus(finding);
  finding.status = status;
  finding.statusReasons = details.detailsUnavailable
    ? [...reasons, "Some details were unavailable"]
    : reasons;
  return finding;
}

/** Assemble a report from column findings and table-level facts (pure). */
export function assembleReport(args: {
  target: AutopsyTarget;
  rows: number;
  columns: ColumnFinding[];
  duplicateRows: number;
  fixes: FixAction[];
  complete: boolean;
}): AutopsyReport {
  const { target, rows, columns, duplicateRows, fixes, complete } = args;
  const nonNull = (c: ColumnFinding): number => Math.max(0, c.rows - c.nullCount);
  const candidateKeys =
    rows > 0
      ? columns.filter((c) => nonNull(c) === rows && c.distinct === rows).map((c) => c.name)
      : [];
  const allNullColumns =
    rows > 0 ? columns.filter((c) => nonNull(c) === 0).map((c) => c.name) : [];
  const constantColumns =
    rows >= 2 ? columns.filter((c) => c.distinct === 1).map((c) => c.name) : [];
  const health = computeHealth({
    rows,
    duplicateRows,
    columns,
    allNullColumns: allNullColumns.length,
    constantColumns: constantColumns.length,
  });
  return {
    version: 1,
    complete,
    status: "ok",
    tableName: target.tableName,
    rows,
    columnCount: columns.length,
    columns,
    duplicateRows,
    candidateKeys,
    allNullColumns,
    constantColumns,
    health,
    fixes,
  };
}

/** A report that carries only a status and a message (error or too large). */
function messageReport(
  target: AutopsyTarget,
  status: "error" | "too-large",
  message: string,
  rows: number
): AutopsyReport {
  return {
    version: 1,
    complete: true,
    status,
    message,
    tableName: target.tableName,
    rows,
    columnCount: target.schema.length,
    columns: [],
    duplicateRows: 0,
    candidateKeys: [],
    allNullColumns: [],
    constantColumns: [],
    health: { score: 0, breakdown: [] },
    fixes: [],
  };
}

// ── Value normalization ─────────────────────────────────────────────────────

/** A finite number from a DuckDB value, or undefined (NULL or non-numeric). */
function num(v: unknown): number | undefined {
  const d = toDisplayValue(v);
  return typeof d === "number" && Number.isFinite(d) ? d : undefined;
}

/** A `YYYY-MM-DD` string from a DuckDB DATE value, or undefined. */
function dateStr(v: unknown): string | undefined {
  const d = toDisplayValue(v, "date");
  return typeof d === "string" && d !== "" ? d : undefined;
}

/** Normalize one column's stage A row into {@link RawColumnStats}. */
function rawStatsFor(
  col: ColumnSchema,
  i: number,
  row: Record<string, unknown>
): RawColumnStats {
  const raw: RawColumnStats = {
    nonNull: num(row[`nn${i}`]) ?? 0,
    distinct: num(row[`d${i}`]) ?? 0,
  };
  if (col.type === "number") {
    raw.min = num(row[`mn${i}`]);
    raw.max = num(row[`mx${i}`]);
    raw.mean = num(row[`av${i}`]);
    raw.median = num(row[`md${i}`]);
    raw.q1 = num(row[`q1_${i}`]);
    raw.q3 = num(row[`q3_${i}`]);
  } else if (col.type === "date") {
    raw.min = dateStr(row[`mn${i}`]);
    raw.max = dateStr(row[`mx${i}`]);
    const mean = num(row[`av${i}`]);
    const median = num(row[`md${i}`]);
    raw.mean = mean === undefined ? undefined : epochSecondsToIsoDate(mean);
    raw.median = median === undefined ? undefined : epochSecondsToIsoDate(median);
  }
  return raw;
}

// ── The engine ─────────────────────────────────────────────────────────────

export interface AutopsyOptions {
  /** Offer Fix it actions (false for stitched results). Default true. */
  allowFixes?: boolean;
  /** Called with a partial report after each stage. Errors are ignored. */
  onProgress?: (report: AutopsyReport) => void;
}

/**
 * Run an Autopsy on one table. Read-only, staged, and never throws: any failure
 * becomes a report with `status: "error"` (or a column with unavailable
 * details), per Requirement 7.7.
 */
export async function runAutopsy(
  db: DuckDBService,
  target: AutopsyTarget,
  options: AutopsyOptions = {}
): Promise<AutopsyReport> {
  const allowFixes = options.allowFixes ?? true;
  const emit = (report: AutopsyReport): void => {
    try {
      options.onProgress?.(report);
    } catch {
      /* a failing listener must never break the autopsy */
    }
  };
  const schema = target.schema;

  // Cheap guard first: refuse an oversized table before scanning it at all.
  if (target.rowCount > AUTOPSY_MAX_ROWS) {
    return messageReport(
      target,
      "too-large",
      `This table has ${target.rowCount.toLocaleString()} rows. The Autopsy analyzes tables of up to ${AUTOPSY_MAX_ROWS.toLocaleString()} rows.`,
      target.rowCount
    );
  }

  // Stage A: one aggregate pass over the whole table.
  let statsRow: Record<string, unknown>;
  try {
    const rows = await db.query<Record<string, unknown>>(
      buildStageASql(target.tableName, schema)
    );
    statsRow = rows[0] ?? {};
  } catch {
    return messageReport(target, "error", "The lab could not read this table's statistics.", 0);
  }
  const rowCount = num(statsRow.n) ?? 0;
  if (rowCount > AUTOPSY_MAX_ROWS) {
    return messageReport(
      target,
      "too-large",
      `This table has ${rowCount.toLocaleString()} rows. The Autopsy analyzes tables of up to ${AUTOPSY_MAX_ROWS.toLocaleString()} rows.`,
      rowCount
    );
  }

  // Exact duplicate rows (same method as the existing duplicate rule).
  let duplicateRows = 0;
  try {
    const rows = await db.query<Record<string, unknown>>(
      buildDuplicatesSql(target.tableName)
    );
    duplicateRows = Math.max(0, num(rows[0]?.dups) ?? 0);
  } catch {
    return messageReport(target, "error", "The lab could not count duplicate rows.", rowCount);
  }

  const raws = schema.map((col, i) => rawStatsFor(col, i, statsRow));
  const details: ColumnDetails[] = schema.map(() => ({}));
  const snapshot = (complete: boolean, fixes: FixAction[]): AutopsyReport =>
    assembleReport({
      target,
      rows: rowCount,
      columns: schema.map((col, i) => buildColumnFinding(col, rowCount, raws[i], details[i])),
      duplicateRows,
      fixes,
      complete,
    });

  emit(snapshot(false, []));

  // Stage B: per-column details, sequential so each column renders as it lands.
  for (let i = 0; i < schema.length; i += 1) {
    try {
      details[i] = await columnDetails(db, target.tableName, schema[i], raws[i]);
    } catch {
      details[i] = { detailsUnavailable: true };
    }
    emit(snapshot(false, []));
  }

  // Stage C: the existing cleaning rules (category variants and fix actions).
  let fixes: FixAction[] = [];
  try {
    const proposals = await loadCleaningProposals(db, target);
    schema.forEach((col, i) => {
      if (col.type !== "string") return;
      const category = proposals.find(
        (p) => p.id === `clean:category:${target.tableName}.${col.name}`
      );
      if (category) {
        details[i] = {
          ...details[i],
          categoryVariants: Object.keys(category.variantMap ?? {}).length,
        };
      }
    });
    fixes = allowFixes ? toFixActions(proposals) : [];
  } catch {
    fixes = [];
  }
  return snapshot(true, fixes);
}

/** Stage B queries for one column. Throws on a query failure (caller catches). */
async function columnDetails(
  db: DuckDBService,
  tableName: string,
  col: ColumnSchema,
  raw: RawColumnStats
): Promise<ColumnDetails> {
  const details: ColumnDetails = {};

  if (raw.nonNull > 0 && raw.distinct <= AUTOPSY_LOW_CARDINALITY_MAX) {
    const rows = await db.query<Record<string, unknown>>(
      buildTopValuesSql(tableName, col.name, AUTOPSY_TOP_VALUES)
    );
    details.topValues = rows.map((r) => ({
      value: String(toDisplayValue(r.v)),
      count: num(r.c) ?? 0,
    }));
  }

  if (col.type === "string" && raw.nonNull > 0) {
    const rows = await db.query<Record<string, unknown>>(
      buildStringVariantsSql(tableName, col.name)
    );
    details.whitespaceRows = num(rows[0]?.ws) ?? 0;
    details.caseVariantGroups = num(rows[0]?.cg) ?? 0;
  }

  if (
    col.type === "number" &&
    raw.nonNull > 0 &&
    raw.q1 !== undefined &&
    raw.q3 !== undefined &&
    raw.median !== undefined
  ) {
    const iqr = raw.q3 - raw.q1;
    if (iqr > 0) {
      const lower = raw.q1 - AUTOPSY_IQR_FACTOR * iqr;
      const upper = raw.q3 + AUTOPSY_IQR_FACTOR * iqr;
      const counted = await db.query<Record<string, unknown>>(
        buildOutlierCountSql(tableName, col.name, lower, upper)
      );
      const count = num(counted[0]?.oc) ?? 0;
      let examples: number[] = [];
      if (count > 0) {
        const rows = await db.query<Record<string, unknown>>(
          buildOutlierExamplesSql(
            tableName,
            col.name,
            lower,
            upper,
            Number(raw.median),
            AUTOPSY_OUTLIER_EXAMPLES
          )
        );
        examples = rows
          .map((r) => num(r.v))
          .filter((v): v is number => v !== undefined);
      }
      details.outliers = { count, lower, upper, examples };
    }
  }
  return details;
}
