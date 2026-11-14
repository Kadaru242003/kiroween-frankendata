/**
 * SQL script builder (Feature 5, Requirement 5): a readable DuckDB script that
 * reproduces an applied stitch from the ORIGINAL files, for use outside the app.
 *
 * Pure. Reuses the existing builders `buildCleanedCopySql` and
 * `buildJoinChainSql` (so the script and the app share one implementation of
 * the cleaning and join SQL). Every identifier goes through `quoteIdent`, every
 * string literal through `quoteString`, and any text taken from a name that is
 * placed in a comment is reduced to one safe line by {@link commentSafe}. The
 * script contains no row values.
 */
import {
  buildCleanedCopySql,
  buildJoinChainSql,
  groupApprovedForTable,
  type JoinTableInput,
} from "../stitching/stitch-applier";
import { quoteIdent, quoteString } from "../stitching/sql-escape";
import type { StitchPlan } from "../stitching/types";
import { COLUMN_TYPE_TO_DUCKDB_TYPE } from "../types";
import type { ColumnSchema, LoadedTable } from "../types";

/** The fixed apply counter used in the script, so table names are stable. */
export const SCRIPT_APPLY_COUNTER = 1;

/** The path prefix of every file placeholder in the script. */
export const SCRIPT_PATH_PLACEHOLDER = "/path/to/";

export interface BuildSqlScriptInput {
  plan: StitchPlan;
  tables: readonly Pick<
    LoadedTable,
    "tableName" | "sourceFileName" | "schema" | "rowCount"
  >[];
  now: Date;
}

/**
 * Reduce arbitrary text to one safe line for a `--` comment: control characters
 * and whitespace runs become one space, and comment markers are removed.
 */
export function commentSafe(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ")
    .replace(/\/\*|\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** `frankendata-stitch-<yyyy-mm-dd>.sql` (Requirement 5.1). */
export function sqlScriptFileName(date: Date): string {
  return `frankendata-stitch-${date.toISOString().slice(0, 10)}.sql`;
}

const NULL_TOKENS = "('', 'N/A', 'NA', 'null', '-')";

/** Best-effort conversion of a raw text column to its typed value. */
function typedExpr(column: ColumnSchema): string {
  const raw = quoteIdent(column.name);
  const trimmed = `trim(${raw})`;
  const isNull = `upper(${trimmed}) IN ${NULL_TOKENS.toUpperCase()}`;
  switch (column.type) {
    case "number":
      return (
        `CASE WHEN ${isNull} THEN NULL ELSE TRY_CAST(` +
        `replace(replace(replace(replace(${trimmed}, '$', ''), ',', ''), '%', ''), ` +
        `'\u20ac', '') AS DOUBLE) END`
      );
    case "boolean":
      return (
        `CASE lower(${trimmed}) ` +
        `WHEN 'true' THEN TRUE WHEN 'yes' THEN TRUE WHEN 'y' THEN TRUE WHEN '1' THEN TRUE ` +
        `WHEN 'false' THEN FALSE WHEN 'no' THEN FALSE WHEN 'n' THEN FALSE WHEN '0' THEN FALSE ` +
        `ELSE NULL END`
      );
    case "date":
      return `CASE WHEN ${isNull} THEN NULL ELSE TRY_CAST(${trimmed} AS DATE) END`;
    case "string":
    default:
      return `CASE WHEN ${isNull} THEN NULL ELSE ${raw} END`;
  }
}

function placeholderPath(sourceFileName: string): string {
  const name = sourceFileName.replace(/\.xlsx$/i, ".csv");
  return `${SCRIPT_PATH_PLACEHOLDER}${name}`;
}

/** Build the SQL script text for an applied plan (Requirement 5.2 to 5.5). */
export function buildSqlScript(input: BuildSqlScriptInput): string {
  const { plan, tables, now } = input;
  const n = SCRIPT_APPLY_COUNTER;

  const referenced = new Set<string>();
  if (plan.anchorTableName) referenced.add(plan.anchorTableName);
  for (const m of plan.approvedMatches) {
    referenced.add(m.left.tableName);
    referenced.add(m.right.tableName);
  }
  for (const c of plan.approvedCleanings) referenced.add(c.target.tableName);
  const used = tables.filter((t) => referenced.has(t.tableName));

  const out: string[] = [];
  out.push("-- FrankenData SQL script");
  out.push(`-- Generated ${now.toISOString().slice(0, 10)} by FrankenData`);
  out.push("-- Reproduces the approved cleanups and the join from your original files.");
  out.push(`-- Replace each '${SCRIPT_PATH_PLACEHOLDER}...' placeholder with the real path of your file.`);
  out.push("-- Run with DuckDB (duckdb.org). Statements run from top to bottom.");
  out.push("-- Note: this loads each file as text and converts it with simple rules.");
  out.push("-- FrankenData's own file reading is more tolerant (currency, percent signs,");
  out.push("-- mixed date formats), so adjust the conversions below if your files need it.");
  out.push("");

  // Step 1: load the original tables.
  out.push("-- Step 1: load the original tables");
  for (const t of used) {
    out.push("");
    out.push(`-- Table ${commentSafe(t.tableName)} from ${commentSafe(t.sourceFileName)}`);
    if (/\.xlsx$/i.test(t.sourceFileName)) {
      out.push("-- This source is an Excel file: save the sheet as CSV and use that path.");
    }
    const defs = t.schema
      .map((c) => `${quoteIdent(c.name)} ${COLUMN_TYPE_TO_DUCKDB_TYPE[c.type]}`)
      .join(", ");
    out.push(`CREATE TABLE ${quoteIdent(t.tableName)} (${defs});`);
    const exprs = t.schema.map((c) => typedExpr(c)).join(", ");
    const names = t.schema.map((c) => quoteString(c.name)).join(", ");
    out.push(
      `INSERT INTO ${quoteIdent(t.tableName)} SELECT ${exprs} FROM read_csv(` +
        `${quoteString(placeholderPath(t.sourceFileName))}, header = true, ` +
        `all_varchar = true, names = [${names}]);`
    );
  }

  // Step 2: cleaned copies.
  const cleaningsByTable = new Map<string, StitchPlan["approvedCleanings"]>();
  for (const c of plan.approvedCleanings) {
    const bucket = cleaningsByTable.get(c.target.tableName) ?? [];
    bucket.push(c);
    cleaningsByTable.set(c.target.tableName, bucket);
  }
  const joinInputs: JoinTableInput[] = [];
  const cleanSteps: string[] = [];
  for (const t of used) {
    const approved = cleaningsByTable.get(t.tableName) ?? [];
    if (approved.length > 0) {
      const grouped = groupApprovedForTable([...t.schema], approved);
      const sql = buildCleanedCopySql(n, t.tableName, [...t.schema], grouped);
      cleanSteps.push("");
      cleanSteps.push(`-- Cleaned copy of ${commentSafe(t.tableName)}`);
      cleanSteps.push(`${sql.createSql};`);
      cleanSteps.push(`${sql.insertSql};`);
      joinInputs.push({
        tableName: t.tableName,
        readTableName: sql.tableName,
        schema: sql.columns,
        rowCount: t.rowCount,
      });
    } else {
      joinInputs.push({
        tableName: t.tableName,
        readTableName: t.tableName,
        schema: [...t.schema],
        rowCount: t.rowCount,
      });
    }
  }
  out.push("");
  out.push("-- Step 2: cleaned copies (the originals stay untouched)");
  if (cleanSteps.length === 0) {
    out.push("-- No cleanups were approved.");
  } else {
    out.push(...cleanSteps);
  }

  // Step 3: the join.
  out.push("");
  out.push("-- Step 3: the joined result");
  if (joinInputs.length > 0) {
    const join = buildJoinChainSql(
      n,
      joinInputs,
      plan.approvedMatches,
      plan.anchorTableName
    );
    out.push(`${join.createSql};`);
  } else {
    out.push("-- No tables were part of this stitch.");
  }
  out.push("");
  return out.join("\n");
}
