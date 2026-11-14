// @vitest-environment node
/**
 * Feasibility proof (task 1): the BUILT server boots over stdio in a real
 * subprocess and `frankendata_load_files` loads the demo CSVs through the
 * existing core under Node.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(repo, "mcp/dist/server.js");
let client: Client;

beforeAll(async () => {
  if (!existsSync(dist)) {
    execFileSync("node", ["mcp/build.mjs"], { cwd: repo, stdio: "ignore" });
  }
  const transport = new StdioClientTransport({
    command: "node",
    args: [dist],
    cwd: repo,
    env: { ...process.env, FRANKENDATA_MCP_ROOT: repo } as Record<string, string>,
    stderr: "ignore",
  });
  client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
}, 60000);
afterAll(async () => {
  await client?.close();
});

describe("built server over stdio", () => {
  it("loads the demo CSVs and rejects a path outside the root", async () => {
    const res = (await client.callTool({
      name: "frankendata_load_files",
      arguments: {
        paths: ["mcp/fixtures/monsters.csv", "mcp/fixtures/experiments.csv", "../outside.csv"],
      },
    })) as { structuredContent: any };
    const { tables, failures } = res.structuredContent;
    expect(tables.map((t: any) => [t.tableName, t.rowCount])).toEqual([
      ["monsters", 14],
      ["experiments", 13],
    ]);
    expect(tables[0].columns[3]).toEqual({ name: "Sedated", type: "boolean" });
    expect(failures[0].code).toBe("path-outside-root");
  }, 60000);

  it("maps invalid input to the invalid-input code", async () => {
    const res = (await client.callTool({
      name: "frankendata_load_files",
      arguments: { paths: 5 },
    })) as { isError: boolean; structuredContent: any };
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe("invalid-input");
  });
});
