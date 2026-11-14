/** Structured errors for every tool (Requirement 11). */
export const ERROR_CODES = [
  "invalid-input",
  "invalid-path",
  "path-outside-root",
  "file-not-found",
  "file-exists",
  "table-not-found",
  "no-proposals",
  "proposals-stale",
  "unknown-proposal",
  "invalid-recipe",
  "sql-rejected",
  "query-failed",
  "export-failed",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ToolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export function toolError(code: ErrorCode, message: string): ToolError {
  return new ToolError(code, message);
}
