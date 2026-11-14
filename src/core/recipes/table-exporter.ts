/**
 * Table exporter (Feature 5, Requirement 1): CSV, Excel (.xlsx), and Parquet
 * export of a FULL loaded table or stitched result. Read-only: it only issues
 * SELECT / COPY statements built from `quoteIdent`, `quoteString`, and
 * application-generated names.
 */
import * as XLSX from "xlsx";
import { toCsv } from "../chat/csv-export";
import { quoteIdent, quoteString } from "../stitching/sql-escape";
import type { ColumnSchema, DuckDBService, LoadedTable } from "../types";
import { EXPORT_MAX_ROWS } from "./types";
import type { ExportFormat } from "./types";

export type ExportCell = string | number | boolean | null;

export interface TableData {
  columns: string[];
  types: ColumnSchema["type"][];
  rows: ExportCell[][];
}

/** The result of an export: a file name, a MIME type, and the content. */
export interface ExportedFile {
  fileName: string;
  mime: string;
  data: string | Uint8Array;
}

const EXTENSIONS: Record<ExportFormat, string> = {
  csv: "csv",
  xlsx: "xlsx",
  parquet: "parquet",
};
const MIMES: Record<ExportFormat, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  parquet: "application/vnd.apache.parquet",
};

/** A filesystem-safe file name derived from a table name (Requirement 1.6). */
export function exportFileName(tableName: string, format: ExportFormat): string {
  const stem = tableName
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${stem === "" ? "table" : stem}.${EXTENSIONS[format]}`;
}

function toCell(value: unknown, type: ColumnSchema["type"]): ExportCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (value instanceof Date) {
    return type === "date" ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  return String(value);
}

/** Read the FULL table (not the preview) with dates as ISO strings (Req 1.2, 1.3). */
export async function readTable(
  db: DuckDBService,
  table: Pick<LoadedTable, "tableName" | "schema">
): Promise<TableData> {
  const select = table.schema
    .map((c) =>
      c.type === "date"
        ? `CAST(${quoteIdent(c.name)} AS VARCHAR) AS ${quoteIdent(c.name)}`
        : quoteIdent(c.name)
    )
    .join(", ");
  const raw = await db.query<Record<string, unknown>>(
    `SELECT ${select} FROM ${quoteIdent(table.tableName)}`
  );
  return {
    columns: table.schema.map((c) => c.name),
    types: table.schema.map((c) => c.type),
    rows: raw.map((r) => table.schema.map((c) => toCell(r[c.name], c.type))),
  };
}

/** RFC 4180 CSV text, NULL as empty (Requirement 1.3). */
export function toCsvText(columns: string[], rows: ExportCell[][]): string {
  return toCsv(
    columns,
    rows.map((r) =>
      r.map((c) => (c === null ? "" : typeof c === "string" ? c : String(c)))
    )
  );
}

function sheetName(tableName: string): string {
  const cleaned = tableName.replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
  return cleaned === "" ? "Sheet1" : cleaned;
}

/** An .xlsx workbook with typed cells (Requirement 1.4). */
export function toXlsxBytes(
  tableName: string,
  data: TableData
): Uint8Array {
  const aoa: unknown[][] = [data.columns];
  for (const row of data.rows) {
    aoa.push(
      row.map((cell, i) => {
        if (cell === null) return null;
        if (data.types[i] === "date" && typeof cell === "string") {
          const d = new Date(`${cell}T00:00:00Z`);
          return Number.isNaN(d.getTime()) ? cell : d;
        }
        return cell;
      })
    );
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith("!")) continue;
    const cell = ws[addr] as XLSX.CellObject;
    if (cell.t === "d") cell.z = "yyyy-mm-dd";
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName(tableName));
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", cellDates: true });
  return new Uint8Array(out as ArrayBuffer);
}

let parquetCounter = 0;

/** Parquet bytes produced by DuckDB itself via COPY to a virtual file (Req 1.5). */
export async function exportParquet(
  db: DuckDBService,
  tableName: string
): Promise<Uint8Array> {
  if (!db.exportFileBytes) {
    throw new Error("Parquet export is not available in this environment.");
  }
  parquetCounter += 1;
  const virtual = `frankendata_export_${parquetCounter}.parquet`;
  const sql =
    `COPY (SELECT * FROM ${quoteIdent(tableName)}) ` +
    `TO ${quoteString(virtual)} (FORMAT PARQUET)`;
  return db.exportFileBytes(sql, virtual);
}

/** Export a table in the chosen format. Throws an Error with a plain message. */
export async function exportTable(
  db: DuckDBService,
  table: Pick<LoadedTable, "tableName" | "schema" | "rowCount">,
  format: ExportFormat
): Promise<ExportedFile> {
  const fileName = exportFileName(table.tableName, format);
  const mime = MIMES[format];
  try {
    if (format === "parquet") {
      return { fileName, mime, data: await exportParquet(db, table.tableName) };
    }
    if (format === "xlsx" && table.rowCount > EXPORT_MAX_ROWS) {
      throw new Error(
        `This table has ${table.rowCount} rows. Excel files hold at most ${EXPORT_MAX_ROWS} data rows. Use CSV or Parquet instead.`
      );
    }
    const data = await readTable(db, table);
    if (format === "csv") {
      return { fileName, mime, data: toCsvText(data.columns, data.rows) };
    }
    return { fileName, mime, data: toXlsxBytes(table.tableName, data) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not export ${table.tableName}: ${reason}`);
  }
}
