/** Entry point: FrankenData MCP server over stdio. Logs only to stderr. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFrankenDataServer } from "./create-server";

const { server } = createFrankenDataServer();
await server.connect(new StdioServerTransport());
process.stderr.write("frankendata-mcp: ready on stdio\n");
