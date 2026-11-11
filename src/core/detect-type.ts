/**
 * File type detection.
 *
 * `detectType` is a pure function that maps a file name's extension to a
 * {@link FileType}. Detection is driven solely by the extension (Req 2.1):
 * `.csv` → `csv` (PapaParse), `.xlsx` → `xlsx` (SheetJS), and anything else →
 * `unsupported` (Req 2.2). The extension match is case-insensitive.
 */

import type { FileType } from "./types";

/**
 * Detect a file's {@link FileType} from its name's extension.
 *
 * The extension is the substring after the final `.` in the file name's base
 * (directory segments are ignored). Matching is case-insensitive, so `DATA.CSV`
 * and `data.csv` both resolve to `csv`.
 *
 * Edge cases:
 * - No extension (`"data"`, `"README"`) → `unsupported`.
 * - Multiple dots (`"my.data.csv"`) → uses the last segment (`csv`).
 * - A trailing dot (`"data."`) leaves an empty extension → `unsupported`.
 * - A leading-dot-only name (`".csv"`) is treated as a dotfile with no
 *   extension → `unsupported`.
 *
 * @param fileName The source file name (may include a directory path).
 * @returns The detected file type.
 */
export function detectType(fileName: string): FileType {
  const ext = extractExtension(fileName);
  switch (ext) {
    case "csv":
      return "csv";
    case "xlsx":
      return "xlsx";
    default:
      return "unsupported";
  }
}

/**
 * Extract the lowercased extension (without the dot) from a file name, or an
 * empty string when there is no extension. Directory segments are stripped
 * first so dots in a path do not interfere.
 */
function extractExtension(fileName: string): string {
  // Strip any directory portion; handle both POSIX and Windows separators.
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const lastDot = base.lastIndexOf(".");
  // No dot, a leading-dot-only name (dotfile), or a trailing dot → no extension.
  if (lastDot <= 0 || lastDot === base.length - 1) {
    return "";
  }
  return base.slice(lastDot + 1).toLowerCase();
}
