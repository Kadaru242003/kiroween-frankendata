/** frankendata_autopsy (Requirement 4). */
import { z } from "zod";
import { runAutopsy } from "../../../src/core/autopsy/autopsy-engine";
import { toMarkdown } from "../../../src/core/autopsy/report-export";
import { okResult, type ToolResult } from "../results";
import type { Session } from "../session";
import { findTable } from "../tables";

export const autopsyShape = {
  table: z.string().describe("A loaded table or a stitched result table name."),
};

export async function autopsy(session: Session, args: { table: string }): Promise<ToolResult> {
  return session.run(async () => {
    const table = await findTable(session, args.table);
    const db = await session.db();
    const report = await runAutopsy(
      db,
      { tableName: table.tableName, schema: table.schema, rowCount: table.rowCount },
      { allowFixes: false }
    );
    return okResult({ report: report as unknown as Record<string, unknown> }, toMarkdown(report));
  });
}
