/**
 * Deterministic "starter question" generation for "Ask the Lab" (Feature 3,
 * task 4).
 *
 * For each {@link QueryableTable}, {@link generateStarterChips} produces up to
 * {@link ASK_MAX_STARTER_CHIPS_PER_TABLE} example questions whose SQL is built
 * BY RULES — no LLM involved — so the feature is fully usable with AI off
 * (Req 2.1–2.4). Clicking a chip runs its SQL directly (still through the
 * SqlValidator, wired at the controller in task 5). Generation is deterministic
 * (same schema → same chips) and only emits chips for the rule patterns that
 * apply to a table's actual columns (Req 2.3).
 *
 * The rule patterns, in fixed order (design: "StarterChips"):
 *   1. total row count                         (always)
 *   2. rows per category — up to TWO eligible string columns (schema order),
 *      each carrying a bar ChartSpec {x: category, y: count}
 *   3. top 10 by the first numeric column
 *   4. min/max/avg of the first numeric column
 *
 * A string column is CATEGORY-ELIGIBLE (pattern 2) only when it has at least 2
 * distinct values, at most ASK_CATEGORY_DISTINCT_MAX distinct values, AND its
 * distinct count is at most 70% of the table's row count. The last gate rejects
 * near-unique columns (for example a 12-distinct name column in a 14-row table)
 * that would produce a useless one-row-per-group chip.
 *
 * Distinct counts for pattern 2 come from a per-string-column probe via the
 * injected {@link DuckDBService.query}, which also reads the table's row count
 * (for the 70% gate); results are gathered once per table. All identifiers are
 * escaped with the shared {@link quoteIdent} helper so a hostile column/table
 * name is harmless.
 *
 * Framework-agnostic: no React, no network (DuckDB is the local engine).
 */

import type { ColumnSchema, DuckDBService } from "../types.js";
import { quoteIdent } from "../stitching/sql-escape.js";
import {
  ASK_MAX_STARTER_CHIPS_PER_TABLE,
  ASK_CATEGORY_DISTINCT_MAX,
  type ChartSpec,
  type QueryableTable,
} from "./types.js";

/** A clickable starter question with its rule-built SQL and optional chart. */
/** Which rule pattern produced a chip (drives the UI display ordering). */
export type StarterChipKind = "category" | "row-count" | "numeric";

export interface StarterChip {
  /** The table this chip queries (for grouping chips in the UI). */
  tableName: string;
  /** The plain-English question shown on the chip. */
  question: string;
  /** The rule-built SQL run directly when the chip is clicked. */
  sql: string;
  /** The rule pattern that produced this chip. */
  kind: StarterChipKind;
  /** A bar chart spec for the rows-per-category chip; absent otherwise. */
  chart?: ChartSpec;
}

/** The maximum rows-per-category chips offered per table. */
export const MAX_CATEGORY_CHIPS_PER_TABLE = 2;
/** A category column's distinct count may be at most this fraction of rows. */
export const CATEGORY_DISTINCT_ROW_FRACTION = 0.7;

/** A probed string column: its name and DISTINCT value count. */
export interface ColumnDistinct {
  column: string;
  distinct: number;
}

/** What a per-table probe yields: the row count + each string column's distinct count. */
export interface TableDistinct {
  rowCount: number;
  columns: ColumnDistinct[];
}

/**
 * Probe each table for its row count and the DISTINCT count of every string
 * column (schema order), so {@link generateStarterChips} can apply the
 * category-eligibility rule. Returns a map tableName → {@link TableDistinct}.
 *
 * Issues one grouped query per table that reads COUNT(*) and a
 * COUNT(DISTINCT col) for each string column at once.
 */
export async function probeDistinctCounts(
  db: DuckDBService,
  tables: QueryableTable[]
): Promise<Map<string, TableDistinct | null>> {
  const out = new Map<string, TableDistinct | null>();
  for (const table of tables) {
    const stringCols = table.columns.filter((c) => c.type === "string");
    if (stringCols.length === 0) {
      out.set(table.tableName, { rowCount: 0, columns: [] });
      continue;
    }
    // One query: total rows + a distinct count per string column, aliased d0..dN.
    const selects = [
      "COUNT(*) AS n",
      ...stringCols.map(
        (c, i) => `COUNT(DISTINCT ${quoteIdent(c.name)}) AS d${i}`
      ),
    ].join(", ");
    const sql = `SELECT ${selects} FROM ${quoteIdent(table.tableName)}`;
    try {
      const rows = await db.query<Record<string, number | bigint>>(sql);
      const row = rows[0] ?? {};
      const rowCount = Number(row.n ?? 0);
      const columns: ColumnDistinct[] = stringCols.map((c, i) => ({
        column: c.name,
        distinct: Number(row[`d${i}`] ?? 0),
      }));
      out.set(table.tableName, { rowCount, columns });
    } catch {
      // A probe failure must never break chip generation; just skip pattern 2.
      out.set(table.tableName, null);
    }
  }
  return out;
}

/** True when a string column qualifies for a rows-per-category chip. */
export function isCategoryEligible(
  distinct: number,
  rowCount: number
): boolean {
  return (
    distinct >= 2 &&
    distinct <= ASK_CATEGORY_DISTINCT_MAX &&
    rowCount > 0 &&
    distinct <= CATEGORY_DISTINCT_ROW_FRACTION * rowCount
  );
}

/**
 * Generate the deterministic starter chips for one table, given its probed
 * {@link TableDistinct} (or null on a probe failure). Pure and deterministic —
 * no DuckDB access here.
 */
export function chipsForTable(
  table: QueryableTable,
  probe: TableDistinct | null
): StarterChip[] {
  const chips: StarterChip[] = [];
  const t = quoteIdent(table.tableName);

  // 1. Row count (always).
  chips.push({
    tableName: table.tableName,
    question: `How many rows are in ${table.tableName}?`,
    sql: `SELECT COUNT(*) AS row_count FROM ${t}`,
    kind: "row-count",
  });

  // 2. Rows per category — up to MAX_CATEGORY_CHIPS_PER_TABLE eligible string
  //    columns, in schema order (so output stays deterministic).
  if (probe) {
    const eligible = probe.columns
      .filter((c) => isCategoryEligible(c.distinct, probe.rowCount))
      .slice(0, MAX_CATEGORY_CHIPS_PER_TABLE);
    for (const c of eligible) {
      const col = quoteIdent(c.column);
      chips.push({
        tableName: table.tableName,
        question: `How many rows per ${c.column} in ${table.tableName}?`,
        sql:
          `SELECT ${col} AS category, COUNT(*) AS count ` +
          `FROM ${t} GROUP BY ${col} ORDER BY count DESC`,
        kind: "category",
        chart: { type: "bar", x: "category", y: "count" },
      });
    }
  }

  // First numeric column drives patterns 3 and 4.
  const firstNumeric = table.columns.find((c) => c.type === "number");
  if (firstNumeric) {
    const col = quoteIdent(firstNumeric.name);

    // 3. Top 10 by the numeric column.
    chips.push({
      tableName: table.tableName,
      question: `What are the top 10 rows in ${table.tableName} by ${firstNumeric.name}?`,
      sql: `SELECT * FROM ${t} ORDER BY ${col} DESC LIMIT 10`,
      kind: "numeric",
    });

    // 4. Min / max / avg of the numeric column.
    chips.push({
      tableName: table.tableName,
      question: `What are the min, max, and average ${firstNumeric.name} in ${table.tableName}?`,
      sql:
        `SELECT MIN(${col}) AS min, MAX(${col}) AS max, AVG(${col}) AS avg ` +
        `FROM ${t}`,
      kind: "numeric",
    });
  }

  return chips.slice(0, ASK_MAX_STARTER_CHIPS_PER_TABLE);
}

/**
 * Generate starter chips for every queryable table. Probes DuckDB once per
 * table for the category distinct count, then builds the chips deterministically.
 */
export async function generateStarterChips(
  db: DuckDBService,
  tables: QueryableTable[]
): Promise<StarterChip[]> {
  const probes = await probeDistinctCounts(db, tables);
  const chips: StarterChip[] = [];
  for (const table of tables) {
    chips.push(...chipsForTable(table, probes.get(table.tableName) ?? null));
  }
  return orderStarterChips(chips);
}

/** Is a table name a Feature 2 joined result (`stitch_<n>_result`)? */
function isStitchResultTable(tableName: string): boolean {
  return /^stitch_\d+_result$/.test(tableName);
}

/** Display rank by chip kind: category < row-count < numeric (lower first). */
function kindRank(kind: StarterChipKind): number {
  switch (kind) {
    case "category":
      return 0;
    case "row-count":
      return 1;
    case "numeric":
      return 2;
  }
}

/**
 * Order chips for display so the most useful come first (Req: chip overflow):
 *   1. chips for `stitch_<n>_result` tables (the joined view) before others;
 *   2. then rows-per-category chips, then row-count, then the numeric chips.
 *
 * The sort is STABLE (a decorate-sort-undecorate on the original index), so
 * generation order is preserved within a rank and the result stays
 * deterministic.
 */
export function orderStarterChips(chips: StarterChip[]): StarterChip[] {
  return chips
    .map((chip, index) => ({
      chip,
      index,
      stitch: isStitchResultTable(chip.tableName) ? 0 : 1,
      kind: kindRank(chip.kind),
    }))
    .sort((a, b) =>
      a.stitch !== b.stitch
        ? a.stitch - b.stitch
        : a.kind !== b.kind
          ? a.kind - b.kind
          : a.index - b.index
    )
    .map((x) => x.chip);
}

/** Narrow a column list to the queryable-column shape (helper for callers). */
export function toQueryableColumns(
  schema: ColumnSchema[]
): QueryableTable["columns"] {
  return schema.map((c) => ({ name: c.name, type: c.type }));
}
