/** Result helpers: JSON text content, structured content, and safe errors. */
import { ToolError, type ErrorCode } from "./errors";
import { MCP_RESULT_MAX_ROWS } from "./limits";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Convert bigint (and other JSON-unsafe values) so JSON.stringify never throws. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}

export function okResult(
  value: Record<string, unknown>,
  markdown?: string
): ToolResult {
  const safeValue = jsonSafe(value) as Record<string, unknown>;
  const content: ToolResult["content"] = [
    { type: "text", text: JSON.stringify(safeValue) },
  ];
  if (markdown !== undefined) content.push({ type: "text", text: markdown });
  return { content, structuredContent: safeValue };
}

export function errorResult(code: ErrorCode, message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    structuredContent: { error: { code, message } },
  };
}

/** Truncate rows for inline results. */
export function limitRows<T>(
  rows: T[],
  max: number = MCP_RESULT_MAX_ROWS
): { rows: T[]; truncated: boolean; totalRows: number } {
  return {
    rows: rows.slice(0, max),
    truncated: rows.length > max,
    totalRows: rows.length,
  };
}

/**
 * Wrap a handler so it never throws to the protocol layer. A ToolError becomes
 * a structured error; anything else becomes `internal` with a generic message
 * (only the tool name and status go to stderr, never values).
 */
export function safe<A>(
  toolName: string,
  handler: (args: A) => Promise<ToolResult>
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ToolError) {
        process.stderr.write(`tool=${toolName} status=${error.code}\n`);
        return errorResult(error.code, error.message);
      }
      process.stderr.write(`tool=${toolName} status=internal\n`);
      return errorResult("internal", "The tool failed unexpectedly.");
    }
  };
}
