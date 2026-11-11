/**
 * Shared type definitions and module interfaces for the FrankenData file-intake
 * pipeline. These types are framework-agnostic so the core logic can be unit-
 * and property-tested without rendering React or spinning up DuckDB.
 *
 * Interfaces here mirror the design document exactly. Free-function
 * implementations live in their own modules (e.g. `detectType` in
 * `./detect-type`); any remaining ambient signatures here are placeholders
 * whose implementations are provided in later tasks.
 */

/** The four supported inferred types (Req 5.3). */
export type ColumnType = "number" | "boolean" | "date" | "string";

/** A file type detected purely from extension. */
export type FileType = "csv" | "xlsx" | "unsupported";

/** A single column's resolved schema. */
export interface ColumnSchema {
  name: string;
  type: ColumnType;
}

/**
 * A cell value as it comes out of the parser (always string-typed; both parsers
 * normalize cell values to strings — incl. XLSX numbers/booleans/Date objects —
 * before type inference, and typing/coercion to DuckDB types happens later).
 */
export type CellValue = string | null;

/** The result of parsing a file, before typing. */
export interface ParsedFile {
  sourceFileName: string;
  /** From the first row (CSV) / first row of first sheet (XLSX). */
  columnNames: string[];
  /** Data rows only, aligned with columnNames. */
  rows: CellValue[][];
}

/** A successfully loaded table. */
export interface LoadedTable {
  /**
   * A monotonically increasing id assigned to this table at intake time
   * (Feature 2 staleness, Req 3.8). The id comes from a per-session sequence
   * owned by {@link IntakeStore}: every table added gets the next value, and
   * values are never reused. Because the id is assigned per `addTable` call —
   * not derived from the file's contents — re-dropping the *same* file (same
   * `sourceFileName` and `rowCount`) still yields a strictly greater `loadId`.
   * Feature 2's `StitchController` derives a `datasetVersion` from the sorted
   * set of current `loadId`s so a re-dropped identical file still invalidates
   * cached proposals (the name+rowCount signature alone would not).
   */
  loadId: number;
  /** Valid, unique DuckDB identifier derived from sourceFileName. */
  tableName: string;
  sourceFileName: string;
  /** The inferred types actually used to create the table. */
  schema: ColumnSchema[];
  /** Total data rows inserted. */
  rowCount: number;
}

/** A per-file failure captured during the pipeline. */
export interface IntakeError {
  sourceFileName: string;
  stage: "validation" | "parsing" | "type-inference" | "loading";
  /** Human-readable; describes the failure. */
  message: string;
  kind:
    | "unsupported-type"
    | "oversized"
    | "empty-file"
    | "bad-encoding"
    | "corrupt-file"
    | "table-load-failed";
}

/** Parser abstraction shared by CSV and XLSX parsers. */
export interface FileParser {
  readonly fileType: FileType;
  parse(file: File): Promise<ParsedFile>;
}

/**
 * Size guard (pure): returns null if ok, else an oversized error descriptor.
 * Implemented in `./check-size` (see `checkSize`).
 */

/** Type inference (pure over its inputs; never throws). */
export interface TypeInferenceLayer {
  infer(columnNames: string[], rows: CellValue[][]): ColumnSchema[];
}

/** Name sanitization (pure). */
export interface NameSanitizer {
  sanitizeTableName(sourceFileName: string, existingNames: string[]): string;
  sanitizeColumnNames(columnNames: string[]): string[];
}

/** DuckDB lifecycle + table operations. */
export interface DuckDBService {
  init(): Promise<void>;
  createTable(
    tableName: string,
    schema: ColumnSchema[],
    rows: CellValue[][]
  ): Promise<LoadedTable>;
  getRowCount(tableName: string): Promise<number>;
  getPreviewRows(
    tableName: string,
    limit: number
  ): Promise<Record<string, unknown>[]>;
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}

/** Bundled demo datasets (no network access). */
export interface DemoDataLoader {
  /** Three demo files routed through the shared pipeline. */
  load(): Promise<File[]>;
}

/** Orchestration entry point. */
export interface IntakeController {
  intake(files: File[]): Promise<void>;
}

/**
 * Mapping from the TypeInferenceLayer's `ColumnType` to the explicit DuckDB
 * column type used when a table is created. This is the mechanism by which we
 * honor "create using the ColumnType values rather than relying on DuckDB
 * auto-typing" (Req 6.5).
 */
export const COLUMN_TYPE_TO_DUCKDB_TYPE: Record<ColumnType, string> = {
  number: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE",
  string: "VARCHAR",
};
