/** frankendata_load_files (Requirement 3). */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { toolError, ToolError, type ErrorCode } from "../errors";
import { MCP_MAX_FILES } from "../limits";
import { okResult, type ToolResult } from "../results";
import type { Session } from "../session";

export const loadFilesShape = {
  paths: z
    .array(z.string())
    .min(1)
    .max(MCP_MAX_FILES)
    .describe("CSV or XLSX file paths inside the allowed root."),
};

interface Failure {
  path: string;
  code: ErrorCode | string;
  message: string;
}

export async function loadFiles(
  session: Session,
  args: { paths: string[] }
): Promise<ToolResult> {
  return session.run(async () => {
    const guard = await session.guard();
    const failures: Failure[] = [];
    const files: File[] = [];
    for (const p of args.paths) {
      try {
        const real = await guard.resolveInput(p);
        const bytes = await fs.readFile(real);
        files.push(new File([new Uint8Array(bytes)], path.basename(real)));
      } catch (error) {
        if (error instanceof ToolError) {
          failures.push({ path: String(p).slice(0, 200), code: error.code, message: error.message });
        } else {
          failures.push({ path: String(p).slice(0, 200), code: "file-not-found", message: "The file could not be read." });
        }
      }
    }
    if (files.length === 0) {
      const first = failures[0];
      throw toolError(
        (first?.code as ErrorCode) ?? "invalid-input",
        first?.message ?? "No readable files were given."
      );
    }
    const controller = await session.intakeController();
    const beforeTables = new Set(session.tables().map((t) => t.tableName));
    const beforeErrors = session.intake.getState().errors.length;
    await controller.intake(files);
    const state = session.intake.getState();
    for (const e of state.errors.slice(beforeErrors)) {
      failures.push({ path: e.sourceFileName, code: e.kind, message: e.message });
    }
    const loaded = state.tables
      .filter((t) => !beforeTables.has(t.tableName))
      .map((t) => ({
        tableName: t.tableName,
        sourceFileName: t.sourceFileName,
        rowCount: t.rowCount,
        columns: t.schema.map((c) => ({ name: c.name, type: c.type })),
      }));
    return okResult({ tables: loaded, failures });
  });
}
