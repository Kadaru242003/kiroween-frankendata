/**
 * Bundles the MCP server to mcp/dist/server.js with Vite's SSR build (vite is
 * already a dev dependency). Packages stay external and load from node_modules
 * at runtime. The browser-only DuckDB asset imports in duckdb-service.ts are
 * external because the server injects its own node connection.
 */
import { build } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: path.join(root, "src/server.ts"),
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [/\.wasm\?url$/, /\.worker\.js\?url$/],
      output: { format: "es", entryFileNames: "server.js" },
    },
  },
});
console.error("mcp: built mcp/dist/server.js");
