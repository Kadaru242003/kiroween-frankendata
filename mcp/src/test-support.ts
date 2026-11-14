/** Test support: an in-process client connected to a fresh server over the SDK's in-memory transport. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFrankenDataServer, type FrankenDataServer } from "./create-server";
import type { SessionOptions } from "./session";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

export interface TestHarness {
  client: Client;
  app: FrankenDataServer;
  root: string;
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: any }>;
  close(): Promise<void>;
}

/** A temp root containing copies of the demo fixtures. */
export function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "frankendata-mcp-")));
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(root, f));
  }
  return root;
}

export async function startHarness(
  options: SessionOptions & { root?: string } = {}
): Promise<TestHarness> {
  const root = options.root ?? makeRoot();
  const app = createFrankenDataServer({ ...options, root });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return {
    client,
    app,
    root,
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content: { type: string; text: string }[];
      };
      return { isError: res.isError === true, data: res.structuredContent ?? JSON.parse(res.content[0].text) };
    },
    async close() {
      await client.close();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
