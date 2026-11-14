/**
 * createFrankenDataServer: builds the McpServer with every frankendata_* tool.
 * Transport-agnostic, so tests can run it in-process.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSession, type Session, type SessionOptions } from "./session";
import { errorResult, safe } from "./results";
import { loadFiles, loadFilesShape } from "./tools/load-files";

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

  return {
    server,
    session,
    async close() {
      session.dispose();
      await server.close();
    },
  };
}
