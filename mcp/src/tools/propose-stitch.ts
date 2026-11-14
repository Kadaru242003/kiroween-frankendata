/** frankendata_propose_stitch (Requirement 5). Rules engine only: no AI. */
import { z } from "zod";
import { toolError } from "../errors";
import { okResult, type ToolResult } from "../results";
import type { Session } from "../session";

export const proposeStitchShape = {
  tables: z
    .array(z.string())
    .optional()
    .describe("Optional subset of loaded tables. Default: all loaded tables."),
};

export async function proposeStitch(
  session: Session,
  args: { tables?: string[] }
): Promise<ToolResult> {
  return session.run(async () => {
    const loaded = session.tables();
    if (loaded.length === 0) {
      throw toolError("table-not-found", "No tables are loaded. Call frankendata_load_files first.");
    }
    if (args.tables !== undefined) {
      const missing = args.tables.filter((n) => !loaded.some((t) => t.tableName === n));
      if (missing.length > 0) {
        throw toolError(
          "table-not-found",
          `Unknown table(s): ${missing.map((m) => m.slice(0, 60)).join(", ")}. Loaded: ${loaded.map((t) => t.tableName).join(", ")}.`
        );
      }
    }
    session.selection.names = args.tables ?? null;
    const controller = await session.stitchController();
    const proposals = await controller.computeProposals();
    return okResult({
      aiUsed: false,
      datasetVersion: session.stitchStore.getDatasetVersion(),
      matches: proposals.matches.map((m) => ({
        id: m.id,
        left: { table: m.left.tableName, column: m.left.columnName, type: m.left.type },
        right: { table: m.right.tableName, column: m.right.columnName, type: m.right.type },
        confidence: m.confidence,
        reason: m.reason,
      })),
      cleanings: proposals.cleanings.map((c) => ({
        id: c.id,
        kind: c.kind,
        table: c.target.tableName,
        column: c.target.columnName ?? null,
        reason: c.reason,
        canonical: c.canonical ?? null,
      })),
    });
  });
}
