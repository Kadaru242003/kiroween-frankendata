/**
 * createFrankenDataServer: builds the McpServer with every frankendata_* tool.
 * Transport-agnostic, so tests can run it in-process.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSession, type Session, type SessionOptions } from "./session";
import { errorResult, safe } from "./results";
import { applyRecipe, applyRecipeShape } from "./tools/apply-recipe";
import { applyStitch, applyStitchShape } from "./tools/apply-stitch";
import { autopsy, autopsyShape } from "./tools/autopsy";
import { exportTool, exportShape } from "./tools/export";
import { loadFiles, loadFilesShape } from "./tools/load-files";
import { proposeStitch, proposeStitchShape } from "./tools/propose-stitch";
import { query, queryShape } from "./tools/query";
import { reset } from "./tools/reset";

export interface FrankenDataServer {
  server: McpServer;
  session: Session;
  close(): Promise<void>;
}

export function createFrankenDataServer(options: SessionOptions = {}): FrankenDataServer {
  const session = createSession(options);
  const server = new McpServer({ name: "frankendata", version: "0.1.0" });

  // Input validation failures are produced by the SDK before a handler runs.
  // Map them to the structured `invalid-input` code (Requirement 1.4). Handlers
  // never throw (safe()), so only validation or unknown-tool errors get here.
  (server as unknown as { createToolError: (m: string) => unknown }).createToolError = (
    message: string
  ) => errorResult("invalid-input", message.slice(0, 500));

  server.registerTool(
    "frankendata_load_files",
    {
      title: "Load files",
      description:
        "Load CSV or XLSX files (paths inside the allowed root) into the in-memory session. Returns table names, row counts and column types.",
      inputSchema: loadFilesShape,
    },
    safe("frankendata_load_files", (args: { paths: string[] }) => loadFiles(session, args))
  );

  server.registerTool(
    "frankendata_autopsy",
    {
      title: "Autopsy",
      description:
        "Data quality report for a loaded or stitched table: health score, breakdown and findings as JSON plus a Markdown summary.",
      inputSchema: autopsyShape,
    },
    safe("frankendata_autopsy", (args: { table: string }) => autopsy(session, args))
  );
  server.registerTool(
    "frankendata_propose_stitch",
    {
      title: "Propose stitch",
      description:
        "Run the deterministic rules engine (no AI, no network) and return proposed column matches and cleanups with confidence and reasons. Nothing is applied.",
      inputSchema: proposeStitchShape,
    },
    safe("frankendata_propose_stitch", (args: { tables?: string[] }) =>
      proposeStitch(session, args)
    )
  );
  server.registerTool(
    "frankendata_apply_stitch",
    {
      title: "Apply stitch",
      description:
        "Apply ONLY the approved proposal ids passed in (from frankendata_propose_stitch). Creates stitch_ tables; originals are never changed.",
      inputSchema: applyStitchShape,
    },
    safe(
      "frankendata_apply_stitch",
      (args: { approvedIds: string[]; anchor?: string; joinKeys?: Record<string, string> }) =>
        applyStitch(session, args)
    )
  );
  server.registerTool(
    "frankendata_apply_recipe",
    {
      title: "Apply recipe",
      description:
        "Validate a saved FrankenData recipe JSON, map it onto the loaded tables, and apply it. Returns the result and the not-applied list.",
      inputSchema: applyRecipeShape,
    },
    safe("frankendata_apply_recipe", (args: { path: string }) => applyRecipe(session, args))
  );
  server.registerTool(
    "frankendata_query",
    {
      title: "Query",
      description:
        "Run one read-only SELECT or WITH query over the loaded and stitched tables. Validated first; rows are capped.",
      inputSchema: queryShape,
    },
    safe("frankendata_query", (args: { sql: string }) => query(session, args))
  );
  server.registerTool(
    "frankendata_export",
    {
      title: "Export",
      description:
        "Write a loaded or stitched table to CSV or XLSX inside the output folder. Never overwrites unless overwrite is true.",
      inputSchema: exportShape,
    },
    safe(
      "frankendata_export",
      (args: { table: string; format: "csv" | "xlsx"; fileName?: string; overwrite?: boolean }) =>
        exportTool(session, args)
    )
  );
  server.registerTool(
    "frankendata_reset",
    {
      title: "Reset",
      description: "Drop all session tables. Files on disk are never touched.",
      inputSchema: {},
    },
    safe("frankendata_reset", () => reset(session))
  );

  return {
    server,
    session,
    async close() {
      session.dispose();
      await server.close();
    },
  };
}
