/**
 * XLSX parsing for the FrankenData file-intake pipeline.
 *
 * {@link XlsxParser} wraps SheetJS (`xlsx`). It reads the dropped file as an
 * `ArrayBuffer`, parses the first sheet, and preserves the first row of that
 * sheet as `columnNames` (Req 4.1, 4.4). The remaining rows are returned as the
 * data rows of a {@link ParsedFile}.
 *
 * Every cell value is normalized to a consistent STRING representation before
 * it enters the type-inference pipeline (Clarification 3):
 *   - numbers           → their string form (`String(n)`)
 *   - booleans          → `"true"` / `"false"`
 *   - `Date` objects    → ISO `YYYY-MM-DD` string
 *   - strings           → as-is
 *   - null / undefined / blank → `null`
 *
 * Reading with `{ cellDates: true }` means date-formatted cells (which SheetJS
 * would otherwise surface as Excel serial-date numbers) arrive as JS `Date`
 * objects, which are then formatted to ISO `YYYY-MM-DD` (Req 4.5). As a
 * defensive fallback, a value that still looks like an Excel serial-date number
 * is converted via the Excel 1900 epoch when the originating cell is
 * date-formatted. This guarantees the {@link TypeInferenceLayer} always
 * receives `string | null` inputs regardless of the source cell format.
 *
 * Failure handling follows the shared parser convention: parse failures reject
 * the returned promise by throwing an {@link IntakeFailure} carrying a
 * structured {@link IntakeError}. Empty workbooks (no sheets / zero data rows)
 * throw an `empty-file` error (Req 4.2); corrupt/unreadable files throw a
 * `corrupt-file` error (Req 4.3).
 */

import * as XLSX from "xlsx";
import type { CellValue, FileParser, IntakeError, ParsedFile } from "./types";
import { IntakeFailure } from "./intake-failure";

/**
 * A raw cell value as SheetJS may surface it under
 * `{ header: 1, raw: true, cellDates: true }`.
 */
type RawCell = string | number | boolean | Date | null | undefined;

/**
 * Parses XLSX files with SheetJS and produces a {@link ParsedFile} whose cell
 * values are all normalized to `string | null`.
 */
export class XlsxParser implements FileParser {
  readonly fileType = "xlsx" as const;

  async parse(file: File): Promise<ParsedFile> {
    const sourceFileName = file.name;

    // Read the file bytes. A failure here means the file could not be read.
    let data: ArrayBuffer;
    try {
      data = await file.arrayBuffer();
    } catch (cause) {
      throw new IntakeFailure(corruptFileError(sourceFileName, cause));
    }

    // Parse the workbook. `cellDates: true` surfaces date cells as JS Date
    // objects rather than Excel serial numbers. Any throw here is treated as a
    // corrupt/unreadable workbook.
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(new Uint8Array(data), {
        type: "array",
        cellDates: true,
      });
    } catch (cause) {
      throw new IntakeFailure(corruptFileError(sourceFileName, cause));
    }

    // No sheets → empty workbook (Req 4.2).
    const firstSheetName = workbook.SheetNames[0];
    if (firstSheetName === undefined) {
      throw new IntakeFailure(emptyFileError(sourceFileName));
    }

    const sheet = workbook.Sheets[firstSheetName];
    if (sheet === undefined) {
      throw new IntakeFailure(emptyFileError(sourceFileName));
    }

    // Read the sheet as an array-of-arrays with the header row first. `raw:
    // true` keeps native cell types (number/boolean/Date) so normalization is
    // driven by the actual value type; `defval: null` makes missing cells
    // explicit nulls; `blankrows: false` drops fully-empty rows.
    let aoa: RawCell[][];
    try {
      aoa = XLSX.utils.sheet_to_json<RawCell[]>(sheet, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      });
    } catch (cause) {
      throw new IntakeFailure(corruptFileError(sourceFileName, cause));
    }

    // No header row at all → empty workbook (Req 4.2).
    const headerRow = aoa[0];
    if (headerRow === undefined) {
      throw new IntakeFailure(emptyFileError(sourceFileName));
    }

    // Column names come from the first row of the first sheet (Req 4.4). They
    // are preserved verbatim here; sanitization happens later (Req 6.4).
    const columnNames = headerRow.map((cell) => String(cell ?? ""));
    const columnCount = columnNames.length;

    // Data rows only (everything after the header). Zero data rows → empty
    // file (Req 4.2).
    const dataRows = aoa.slice(1);
    if (dataRows.length === 0) {
      throw new IntakeFailure(emptyFileError(sourceFileName));
    }

    // Normalize every cell to `string | null`, padding short rows so each row
    // aligns with the column count.
    const rows: CellValue[][] = dataRows.map((row) => {
      const normalized: CellValue[] = new Array(columnCount);
      for (let i = 0; i < columnCount; i++) {
        normalized[i] = normalizeCell(row[i]);
      }
      return normalized;
    });

    return { sourceFileName, columnNames, rows };
  }
}

/**
 * Normalize a single SheetJS cell value to a consistent `string | null`
 * representation (Clarification 3, Req 4.1, 4.5):
 *   - null / undefined       → null
 *   - empty / whitespace-only string → null (a truly missing cell)
 *   - Date object            → ISO `YYYY-MM-DD`
 *   - number                 → `String(n)`
 *   - boolean                → `"true"` / `"false"`
 *   - string                 → as-is
 */
function normalizeCell(cell: RawCell): CellValue {
  if (cell === null || cell === undefined) {
    return null;
  }

  if (cell instanceof Date) {
    return dateToIso(cell);
  }

  switch (typeof cell) {
    case "number":
      // Non-finite numbers cannot be meaningfully represented; treat as null.
      return Number.isFinite(cell) ? String(cell) : null;
    case "boolean":
      return cell ? "true" : "false";
    case "string": {
      // An empty or whitespace-only cell is a missing value. Non-empty strings
      // are preserved verbatim (NullToken handling happens later in inference).
      return cell.trim() === "" ? null : cell;
    }
    default:
      // Any other exotic type is coerced to its string form defensively.
      return String(cell);
  }
}

/**
 * Format a JS `Date` as an ISO `YYYY-MM-DD` string.
 *
 * SheetJS constructs dates (with `cellDates: true`) in a way that the calendar
 * fields read correctly from the UTC getters, so UTC components are used to
 * avoid timezone drift shifting the day.
 */
function dateToIso(date: Date): CellValue {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Build an `empty-file` {@link IntakeError} naming the file (Req 4.2). */
function emptyFileError(sourceFileName: string): IntakeError {
  return {
    sourceFileName,
    stage: "parsing",
    kind: "empty-file",
    message: `File "${sourceFileName}" is empty: the workbook has no sheets or no data rows.`,
  };
}

/** Build a `corrupt-file` {@link IntakeError} naming the file (Req 4.3). */
function corruptFileError(sourceFileName: string, cause: unknown): IntakeError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return {
    sourceFileName,
    stage: "parsing",
    kind: "corrupt-file",
    message: `File "${sourceFileName}" could not be read; it may be corrupt or not a valid XLSX workbook${detail}.`,
  };
}
