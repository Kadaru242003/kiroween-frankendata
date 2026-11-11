/**
 * CSV parsing (PapaParse wrapper).
 *
 * {@link CsvParser} implements the shared {@link FileParser} interface for
 * `.csv` files. It reads the file as text, parses it into rows and columns with
 * PapaParse, preserves the first row as {@link ParsedFile.columnNames}, and
 * returns the remaining data rows in {@link ParsedFile.rows} (Req 3.1, 3.4).
 *
 * Error convention: parse failures reject the returned promise by throwing an
 * {@link IntakeFailure} carrying a structured {@link IntakeError}. The
 * `IntakeController` (task 12.1) catches it and records the failure. This is the
 * same convention the XLSX parser (task 6.1) follows.
 *
 *  - Zero data rows → `empty-file` (Req 3.2).
 *  - Bytes that cannot be decoded as UTF-8 text → `bad-encoding` (Req 3.3).
 *
 * Column names are preserved verbatim here; sanitization happens later in the
 * NameSanitizer (task 9.1), so this parser does NOT sanitize names.
 */

import Papa from "papaparse";
import { IntakeFailure } from "./intake-failure";
import type { CellValue, FileParser, FileType, ParsedFile } from "./types";

export class CsvParser implements FileParser {
  readonly fileType: FileType = "csv";

  async parse(file: File): Promise<ParsedFile> {
    const sourceFileName = file.name;

    // Decode the raw bytes as UTF-8 with fatal error handling so undecodable
    // byte sequences surface as a `bad-encoding` error rather than silently
    // producing replacement characters (Req 3.3).
    const text = await decodeUtf8OrFail(file, sourceFileName);

    // Parse delimited text into an array of string rows. `skipEmptyLines`
    // drops fully blank lines so a trailing newline does not become a bogus
    // empty data row. Values stay as strings; typing happens later.
    const result = Papa.parse<string[]>(text, {
      skipEmptyLines: "greedy",
    });

    const rawRows = result.data;

    // No rows at all (file was empty or only blank lines) → empty file.
    if (rawRows.length === 0) {
      throw emptyFileError(sourceFileName);
    }

    // The first row is the header; the rest are data rows.
    const [header, ...dataRows] = rawRows;
    const columnNames = header.map((name) => String(name));

    // A header with zero following data rows is an empty file (Req 3.2).
    if (dataRows.length === 0) {
      throw emptyFileError(sourceFileName);
    }

    // Normalize each cell to the CellValue shape (string | null). PapaParse
    // yields strings for every cell when not type-converting; empty cells are
    // empty strings, which the type-inference layer treats as NullTokens later.
    const rows: CellValue[][] = dataRows.map((row) =>
      row.map((cell) => (cell == null ? null : String(cell)))
    );

    return { sourceFileName, columnNames, rows };
  }
}

/**
 * Read the file's bytes and decode them as UTF-8, throwing a `bad-encoding`
 * {@link IntakeFailure} if the bytes are not valid UTF-8 (Req 3.3).
 */
async function decodeUtf8OrFail(
  file: File,
  sourceFileName: string
): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    // `fatal: true` makes the decoder throw on any undecodable byte sequence
    // instead of inserting U+FFFD replacement characters.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(buffer);
  } catch {
    throw new IntakeFailure({
      sourceFileName,
      stage: "parsing",
      kind: "bad-encoding",
      message: `The file "${sourceFileName}" has a bad encoding and could not be read as text.`,
    });
  }
}

/** Build the `empty-file` failure for a CSV with zero data rows (Req 3.2). */
function emptyFileError(sourceFileName: string): IntakeFailure {
  return new IntakeFailure({
    sourceFileName,
    stage: "parsing",
    kind: "empty-file",
    message: `The file "${sourceFileName}" is empty: it contains no data rows.`,
  });
}
