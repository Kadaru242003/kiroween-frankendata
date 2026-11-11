/**
 * File size validation guard for the FrankenData file-intake pipeline.
 *
 * `checkSize` is a pure guard: it returns `null` when a file is within the
 * 25 MB limit, otherwise an `IntakeError` of kind `oversized` naming the file
 * and stating the 25 MB limit (Req 2.3).
 */

import type { IntakeError } from "./types";

/** The maximum accepted file size: 25 MB expressed in bytes. */
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Human-readable form of the limit, reused in the error message. */
const MAX_FILE_SIZE_LABEL = "25 MB";

/**
 * Validate a file's size against the 25 MB limit.
 *
 * A file exactly at the limit is considered within the limit; only files
 * strictly larger than 25 MB are rejected ("larger than 25 MB").
 *
 * @param fileSizeBytes - The file's size in bytes.
 * @param fileName - The source file name, used in the error message.
 * @returns `null` if the file is within the limit, else an `oversized`
 *   `IntakeError` naming the file and stating the 25 MB limit.
 */
export function checkSize(
  fileSizeBytes: number,
  fileName: string
): IntakeError | null {
  if (fileSizeBytes <= MAX_FILE_SIZE_BYTES) {
    return null;
  }

  return {
    sourceFileName: fileName,
    stage: "validation",
    kind: "oversized",
    message: `File "${fileName}" exceeds the ${MAX_FILE_SIZE_LABEL} limit and was skipped.`,
  };
}
