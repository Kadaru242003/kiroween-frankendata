/** frankendata_query (Requirement 8): validator first, then the fetch cap. */
import { z } from "zod";
import { wrapWithFetchCap } from "../../../src/core/chat/ask-controller";
import { createDuckDbQueryRunner } from "../../../src/core/chat/query-runner";
import { toDisplayRows } from "../../../src/core/chat/result-convert";
import { validateSql } from "../../../src/core/chat/sql-validator";
import { toolError } from "../errors";
import { limitRows, okResult, type ToolResult } from "../results";
import type { Session } from "../session";
import { queryableNames } from "../tables";

export const queryShape = {
  sql: z.string().describe("One read-only SELECT or WITH statement over the loaded and stitched tables."),
};

export async function query(session: Session, args: { sql: string }): Promise<ToolResult> {
  return session.run(async () => {
    const names = await queryableNames(session);
    // The validator runs BEFORE any DuckDB execution (Property 2).
    const validation = validateSql(args.sql, names);
    if (!validation.ok) {
      throw toolError("sql-rejected", `The query was rejected: ${validation.reason}.`);
    }
    const db = await session.db();
    let exec;
    try {
      exec = await createDuckDbQueryRunner(db)(wrapWithFetchCap(validation.sql));
    } catch (error) {
      const msg = error instanceof Error ? error.message : "The query failed.";
      throw toolError("query-failed", msg.slice(0, 300));
    }
    const display = toDisplayRows(exec.rows, exec.columns, exec.timestampColumns, exec.dateColumns);
    const objects = display.map((r) => Object.fromEntries(exec.columns.map((c, i) => [c, r[i]])));
    const limited = limitRows(objects);
    return okResult({
      sql: validation.sql,
      columns: exec.columns,
      rows: limited.rows,
      rowCount: limited.totalRows,
      truncated: limited.truncated,
    });
  });
}
