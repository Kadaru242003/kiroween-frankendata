/**
 * SampleReader — reads up to {@link MAX_SAMPLE_VALUES_PER_COLUMN} distinct
 * values *with their frequencies* per column from DuckDB, producing the
 * {@link TableSample}s the deterministic {@link RulesEngine} matches and cleans
 * over (Feature 2, task 4).
 *
 * ## Determinism (design: "SampleReader query", Req 5.2)
 *
 * An unordered `SELECT DISTINCT col … LIMIT 200` is **nondeterministic**
 * (DuckDB may return any 200 of the distinct values in any order) and carries
 * no frequencies, which would break both repeatable output (Req 5.2) and the
 * "most frequent form" cleaning rule. Instead, per column, the reader issues a
 * fully-ordered, frequency-carrying query:
 *
 * ```sql
 * SELECT CAST(col AS VARCHAR) AS value, COUNT(*) AS n
 * FROM <table>
 * WHERE col IS NOT NULL
 * GROUP BY col
 * ORDER BY n DESC, value ASC
 * LIMIT 200;              -- MAX_SAMPLE_VALUES_PER_COLUMN
 * ```
 *
 * This is ordered by count descending, then the string value ascending as the
 * lexicographic tie-break (the **global tie-break** used everywhere: equally
 * frequent values rank by smallest value). So the top-N set and its order are
 * deterministic, and each {@link SampleValue} carries its frequency `n`.
 *
 * NULLs are **excluded** from the matching/cleaning sets (`WHERE col IS NOT
 * NULL`): they are handled separately upstream as null tokens, and the overlap
 * / clustering logic operates on non-null distinct values only. Every returned
 * `SampleValue.value` is therefore a non-null string.
 *
 * `value` is `CAST(… AS VARCHAR)` so the ordering tie-break and all downstream
 * normalization/folding operate on a single, stable string representation of
 * each cell regardless of its DuckDB column type (number/boolean/date/string).
 */

import type { ColumnSchema, DuckDBService, LoadedTable } from "../types";
import {
  MAX_SAMPLE_VALUES_PER_COLUMN,
  type SampleValue,
  type TableSample,
} from "./types";
import { quoteIdent } from "./sql-escape";

/** A single-table view of what the reader needs: name, schema, and row count. */
export interface SampleSourceTable {
  tableName: string;
  schema: ColumnSchema[];
  rowCount: number;
}

/** Reads deterministic, frequency-carrying per-column samples from DuckDB. */
export interface SampleReader {
  /** Build a {@link TableSample} for one table. */
  readTable(table: SampleSourceTable): Promise<TableSample>;
  /** Build {@link TableSample}s for several tables (preserves input order). */
  readTables(tables: SampleSourceTable[]): Promise<TableSample[]>;
}

/** One row of the per-column grouped-count query. */
interface SampleRow {
  value: string | null;
  n: number | bigint;
}

/**
 * Create a {@link SampleReader} backed by a {@link DuckDBService}.
 *
 * The reader only ever issues read-only `SELECT`s through
 * {@link DuckDBService.query}; it never mutates any table, so it is safe to run
 * against the original {@link LoadedTable}s.
 */
export function createSampleReader(db: DuckDBService): SampleReader {
  async function readColumnSamples(
    tableName: string,
    columnName: string
  ): Promise<SampleValue[]> {
    const col = quoteIdent(columnName);
    const table = quoteIdent(tableName);
    // Fully-ordered, frequency-carrying, NULL-excluding, bounded query.
    const sql =
      `SELECT CAST(${col} AS VARCHAR) AS value, COUNT(*) AS n ` +
      `FROM ${table} ` +
      `WHERE ${col} IS NOT NULL ` +
      `GROUP BY ${col} ` +
      `ORDER BY n DESC, value ASC ` +
      `LIMIT ${MAX_SAMPLE_VALUES_PER_COLUMN}`;

    const rows = await db.query<SampleRow>(sql);

    const samples: SampleValue[] = [];
    for (const row of rows) {
      // Defensive: a cell could still surface null if the engine ever returned
      // one despite the IS NOT NULL guard; such a value is not a matching value
      // and is dropped from the set (NULLs excluded from matching, by design).
      if (row.value === null || row.value === undefined) {
        continue;
      }
      samples.push({ value: String(row.value), count: Number(row.n) });
    }
    return samples;
  }

  async function readTable(table: SampleSourceTable): Promise<TableSample> {
    const samplesByColumn: Record<string, SampleValue[]> = {};
    for (const column of table.schema) {
      samplesByColumn[column.name] = await readColumnSamples(
        table.tableName,
        column.name
      );
    }
    return {
      tableName: table.tableName,
      rowCount: table.rowCount,
      // Copy so a caller mutating its LoadedTable.schema can't alias ours.
      schema: table.schema.map((c) => ({ ...c })),
      samplesByColumn,
    };
  }

  async function readTables(
    tables: SampleSourceTable[]
  ): Promise<TableSample[]> {
    const result: TableSample[] = [];
    for (const table of tables) {
      result.push(await readTable(table));
    }
    return result;
  }

  return { readTable, readTables };
}

/**
 * Narrow a {@link LoadedTable} to the {@link SampleSourceTable} shape the reader
 * consumes. Convenience for callers (the `StitchController`) that hold full
 * `LoadedTable`s.
 */
export function toSampleSource(table: LoadedTable): SampleSourceTable {
  return {
    tableName: table.tableName,
    schema: table.schema,
    rowCount: table.rowCount,
  };
}
