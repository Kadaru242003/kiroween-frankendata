---
inclusion: fileMatch
fileMatchPattern: 'mcp/**'
---
# MCP server conventions

The local MCP server lives in `mcp/` and exposes the FrankenData engine to agents over stdio. Rules for any change under `mcp/`:

## Safety

- Every input path goes through `mcp/src/path-guard.ts` (`resolveInput`) before any file read. It compares REAL paths (symlinks resolved) against the real allowed root, which defaults to the working directory and is set by `FRANKENDATA_MCP_ROOT`. Never read or write a path that skipped the guard.
- Input files are opened for reading only. No tool modifies, renames or deletes an input file.
- Exports go only to the output folder (default `frankendata-output` inside the root) through `resolveOutput`. Files are written with the exclusive flag unless the caller passes `overwrite: true`. Symlink targets and links that lead outside the folder are refused.
- Messages show paths relative to the root. Error messages and logs never contain row values or SQL text. Only coarse metadata (tool name and status) goes to stderr. Stdout is the protocol channel and nothing else may write to it.
- Every failure is a structured `ToolError` with a code from `mcp/src/errors.ts`. Handlers are wrapped by `safe()` and never throw to the protocol layer.

## Boundaries

- No network access of any kind and no AI calls. Do not import the AI provider, the AI proxy or the SQL provider modules.
- Reuse `src/core` only through its public functions. Do not change `src/core` behavior from the MCP work. A tiny additive export is allowed only if it is recorded in the spec notes.
- `apply_stitch` applies only proposal ids the caller passes in. `query` runs `validateSql` before any DuckDB call and uses `wrapWithFetchCap`.
- MCP dependencies are devDependencies with exact versions. Nothing from `mcp/` may enter the Vite build, `tsconfig.app.json` or `api/`.

## Build and test

- `npm run mcp:build` (type-check with `mcp/tsconfig.json`, then bundle to `mcp/dist/server.js`) must pass. `mcp/dist` is gitignored.
- MCP tests live next to the code in `mcp/src`, start with `// @vitest-environment node`, and run under `npm test`. Property tests cover the path guard, the query validator, originals staying unchanged, and parity with the web core.
- After rebuilding, reconnect the `frankendata` server from the MCP Server view in Kiro, otherwise Kiro keeps talking to the old process.
