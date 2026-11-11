/**
 * SchemaSummary builder for "Ask the Lab" (Feature 3, task 4).
 *
 * The LLM path sends a bounded {@link SchemaSummary} — table names, column
 * names, types, and a FEW short sample values per column — and NEVER full rows
 * (Req 3.3). {@link buildSchemaSummary} assembles that summary from the
 * queryable tables, reusing the Feature 2 {@link SampleReader} to read
 * deterministic, bounded, NULL-excluding samples from DuckDB, then trims it to
 * the configured limits (Req 3.4):
 *
 *   - sample values per column ≤ ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN, each
 *     truncated to ASK_SCHEMA_MAX_SAMPLE_CHARS characters;
 *   - columns per table ≤ ASK_SCHEMA_MAX_COLUMNS_PER_TABLE;
 *   - tables ≤ ASK_SCHEMA_MAX_TABLES;
 *   - total JSON size ≤ ASK_SCHEMA_MAX_PAYLOAD_BYTES, dropping from the END of
 *     a priority order until it fits.
 *
 * Table priority order (Req 3.4): `stitch_<n>_result` tables first (the most
 * useful joined view), then original LoadedTables, then `stitch_<n>_clean_*`
 * copies. Dropping happens from the end of that order (clean copies first).
 *
 * Framework-agnostic: no React, no network beyond the SampleReader's DuckDB
 * reads.
 */

import {
  ASK_SCHEMA_MAX_TABLES,
  ASK_SCHEMA_MAX_COLUMNS_PER_TABLE,
  ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN,
  ASK_SCHEMA_MAX_SAMPLE_CHARS,
  ASK_SCHEMA_MAX_PAYLOAD_BYTES,
  type SchemaSummary,
  type SchemaTable,
  type SchemaColumn,
  type QueryableTable,
} from "./types.js";
import type { SampleReader, SampleSourceTable } from "../stitching/sample-reader.js";

/** Classify a table for the Req 3.4 priority order. Lower rank = kept longer. */
function tableRank(tableName: string): number {
  // stitch_<n>_result → 0 (kept first); stitch_<n>_clean_* → 2 (dropped first);
  // everything else (originals) → 1.
  if (/^stitch_\d+_result$/.test(tableName)) return 0;
  if (/^stitch_\d+_clean_/.test(tableName)) return 2;
  return 1;
}

/**
 * Order tables by the Req 3.4 priority (result → original → clean), keeping the
 * input order stable within each rank. Returns a new array.
 */
export function orderTablesForSchema(tables: QueryableTable[]): QueryableTable[] {
  return tables
    .map((t, i) => ({ t, i, rank: tableRank(t.tableName) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.i - b.i))
    .map((x) => x.t);
}

/** Truncate a sample value to the per-value character cap. */
function truncateSample(value: string): string {
  return value.length > ASK_SCHEMA_MAX_SAMPLE_CHARS
    ? value.slice(0, ASK_SCHEMA_MAX_SAMPLE_CHARS)
    : value;
}

/** Byte length of the JSON-serialized summary (UTF-8). */
function summaryByteLength(summary: SchemaSummary): number {
  return new TextEncoder().encode(JSON.stringify(summary)).length;
}

/** A row count is needed by the SampleReader; callers pass it per table. */
export interface SchemaSourceTable extends QueryableTable {
  rowCount: number;
}

/**
 * Build a bounded {@link SchemaSummary} from the given tables.
 *
 * @param reader The Feature 2 {@link SampleReader} (reads bounded per-column
 *   samples from DuckDB). Reused rather than re-implementing sampling.
 * @param tables The queryable tables (with row counts) to summarize.
 */
export async function buildSchemaSummary(
  reader: SampleReader,
  tables: SchemaSourceTable[]
): Promise<SchemaSummary> {
  // Order by priority, then cap the number of tables.
  const ordered = orderTablesForSchema(tables).slice(0, ASK_SCHEMA_MAX_TABLES) as SchemaSourceTable[];

  const schemaTables: SchemaTable[] = [];
  for (const table of ordered) {
    const cappedColumns = table.columns.slice(0, ASK_SCHEMA_MAX_COLUMNS_PER_TABLE);
    const source: SampleSourceTable = {
      tableName: table.tableName,
      schema: cappedColumns.map((c) => ({ name: c.name, type: c.type })),
      rowCount: table.rowCount,
    };
    const sample = await reader.readTable(source);

    const columns: SchemaColumn[] = cappedColumns.map((c) => {
      const values = (sample.samplesByColumn[c.name] ?? [])
        .map((s) => s.value)
        .filter((v): v is string => v !== null && v !== undefined)
        .slice(0, ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN)
        .map((v) => truncateSample(v));
      return { name: c.name, type: c.type, samples: values };
    });

    schemaTables.push({ tableName: table.tableName, columns });
  }

  // Trim to the byte budget, dropping from the END of the priority order.
  // First drop whole trailing tables; if a single table still exceeds the
  // budget, drop its samples (lowest-value data) before giving up.
  let summary: SchemaSummary = { tables: schemaTables };
  while (summary.tables.length > 1 && summaryByteLength(summary) > ASK_SCHEMA_MAX_PAYLOAD_BYTES) {
    summary = { tables: summary.tables.slice(0, -1) };
  }
  if (summaryByteLength(summary) > ASK_SCHEMA_MAX_PAYLOAD_BYTES) {
    // Last resort: strip sample values from the remaining table(s).
    summary = {
      tables: summary.tables.map((t) => ({
        tableName: t.tableName,
        columns: t.columns.map((c) => ({ ...c, samples: [] })),
      })),
    };
  }

  return summary;
}
