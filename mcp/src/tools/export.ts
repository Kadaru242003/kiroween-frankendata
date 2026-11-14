/** frankendata_export (Requirement 9): CSV or XLSX inside the output folder. */
import * as fs from "node:fs/promises";
import { z } from "zod";
import { exportFileName, exportTable } from "../../../src/core/recipes/table-exporter";
import { toolError } from "../errors";
import { okResult, type ToolResult } from "../results";
import type { Session } from "../session";
import { findTable } from "../tables";

export const exportShape = {
  table: z.string().describe("A loaded table or stitched result table."),
  format: z.enum(["csv", "xlsx"]),
  fileName: z.string().optional().describe("Optional file name inside the output folder."),
  overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
};

export async function exportTool(
  session: Session,
  args: { table: string; format: "csv" | "xlsx"; fileName?: string; overwrite?: boolean }
): Promise<ToolResult> {
  return session.run(async () => {
    const table = await findTable(session, args.table);
    const name = args.fileName ?? exportFileName(table.tableName, args.format);
    if (!name.toLowerCase().endsWith(`.${args.format}`)) {
      throw toolError("invalid-input", `The file name must end in .${args.format}.`);
    }
    const guard = await session.guard();
    const overwrite = args.overwrite === true;
    const out = await guard.resolveOutput(name, overwrite);
    const db = await session.db();
    let bytes: Uint8Array;
    try {
      const file = await exportTable(db, table, args.format);
      bytes =
        typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data;
      await fs.mkdir(await guard.outputDir(), { recursive: true });
      await fs.writeFile(out.target, bytes, { flag: overwrite ? "w" : "wx" });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EEXIST") {
        throw toolError("file-exists", `${out.relative} already exists. Pass overwrite: true to replace it.`);
      }
      throw toolError("export-failed", "The export failed.");
    }
    return okResult({ path: out.relative, bytes: bytes.length, format: args.format });
  });
}
