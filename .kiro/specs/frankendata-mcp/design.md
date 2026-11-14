# Design Document: FrankenData MCP Server

## Overview

A local stdio MCP server that exposes the FrankenData engine to AI agents. It runs under Node, creates one in-memory DuckDB instance from the node-blocking DuckDB-WASM bundle (the same bundle the existing DuckDB tests use), and wires the existing framework-agnostic `src/core` modules behind eight `frankendata_*` tools. There is no AI call, no network, and no change to the web app.

## Architecture

```
Kiro (MCP client) --stdio--> mcp/src/server.ts (McpServer + StdioServerTransport)
                                   |
                       mcp/src/tools/*.ts  (one handler per tool, zod input schemas)
                                   |
        mcp/src/session.ts  (DuckDB node instance, IntakeStore, StitchStore, controllers)
                                   |
        src/core/*  (intake, autopsy, stitching, recipes, chat validator, exporter)  [reused, unchanged]
        mcp/src/path-guard.ts  (every file access goes through it)
```

### Folder layout

- `mcp/src/server.ts`: entry. Builds the server with `createFrankenDataServer`, connects stdio, logs to stderr only.
- `mcp/src/create-server.ts`: `createFrankenDataServer(options)` returns an `McpServer` with all tools registered. Used by the entry and by in-process tests.
- `mcp/src/session.ts`: `createSession(options)` returns the session object. The DuckDB instance is created lazily.
- `mcp/src/node-duckdb.ts`: creates the node-blocking DuckDB adapter and wraps it with `createDuckDBService` (same technique as `src/core/recipes/duckdb-test-harness.ts`).
- `mcp/src/path-guard.ts`: `createPathGuard({ root, outputDir })`.
- `mcp/src/errors.ts`: `ToolError`, the code set, `toolError(code, message)`, `safe(handler)`.
- `mcp/src/limits.ts`: named constants.
- `mcp/src/results.ts`: `jsonResult(value, markdown?)`, `errorResult(error)`, row truncation.
- `mcp/src/tools/{load-files,autopsy,propose-stitch,apply-stitch,apply-recipe,query,export,reset}.ts`.
- `mcp/fixtures/monsters.csv`, `mcp/fixtures/experiments.csv`: the mismatched demo files as real CSV files (generated from the bundled demo strings, and a test asserts they stay equal).
- `mcp/tsconfig.json`: own config (`noEmit`, bundler resolution, `lib` ES2023 and DOM for the `File` type the core uses, `types: ["node"]`), including `mcp/src` and the `src` files they import.
- `mcp/vite.config.ts` and `mcp/build.mjs`: the bundling step (below).
- `mcp/*.test.ts` next to the code, with an end-to-end test `mcp/src/e2e.test.ts`.
- `.kiro/settings/mcp.json`: the workspace registration.

### Build

Node cannot run the core as-is (extensionless relative imports, `.ts` sources), so `mcp:build` bundles the server with Vite's SSR build through its JavaScript API (`vite` is already a dev dependency, so nothing new is added for bundling):

1. `tsc -p mcp/tsconfig.json --noEmit` type-checks the server and the core files it imports.
2. `node mcp/build.mjs` calls `build({ configFile: false, build: { ssr: "mcp/src/server.ts", outDir: "mcp/dist", target: "node22", rollupOptions: { output: { format: "es", entryFileNames: "server.js" }, external: [/\.wasm\?url$/, /\.worker\.js\?url$/] } }, ssr: { noExternal: [] } })`.

Dependencies (`@modelcontextprotocol/sdk`, `zod`, `papaparse`, `xlsx`, `@duckdb/duckdb-wasm`) stay external and are loaded from `node_modules` at runtime. The browser-only dynamic imports of the DuckDB `?url` assets inside `duckdb-service.ts` are marked external so they are never bundled (they are never executed in Node, because the server injects its own connection).

`package.json` scripts: `mcp:build` = `tsc -p mcp/tsconfig.json && node mcp/build.mjs`, `mcp:start` = `node mcp/dist/server.js`. `mcp/dist` is gitignored. `tsconfig.app.json` keeps `include: ["src"]`, the root `tsconfig.json` references are untouched, and `vitest.config.ts` gains `mcp/**/*.test.ts` in `include` (tests use `// @vitest-environment node`).

## Session model

```ts
interface Session {
  root: string; outputDir: string;
  guard: PathGuard;
  db(): Promise<DuckDBService>;           // lazy; one instance per process
  intake: IntakeStore; stitchStore: StitchStore;
  controller(): Promise<StitchController>; // createStitchController, no AI provider
  selection: { names: string[] | null };   // optional table subset for propose_stitch
  reset(): Promise<string[]>;
}
```

- `createSession` does no work until a tool needs the database. The first call creates the DuckDB instance, the `IntakeController` (`createIntakeController({ duckDBService, store })`), and the stitch controller with `getTables: () => intake.getState().tables` and `selectTable` reading `selection`.
- A tool call is serialized through a promise chain (`session.run(fn)`), because the node-blocking DuckDB instance is single-threaded and the tools mutate shared stores.
- `reset()` calls the controller `undo()` (best effort), `dropAllTables` from `src/core/chat/reset-lab`, `stitchStore.reset()`, and `intake.reset()`.
- `queryableTables()` returns the loaded table names plus the present `stitch_` tables via the existing `discoverStitchTables`.

## Path guard

`createPathGuard({ root, outputDir })` resolves `realRoot = realpath(root)` and `realOut` once (creating the output dir lazily for writes).

`resolveInput(p)`:

1. Reject non-strings, empty strings, and strings containing `\0` (`invalid-path`).
2. `abs = path.resolve(realRoot, p)` (an absolute `p` stays absolute).
3. `real = await realpath(abs)`; a missing file is `file-not-found`.
4. Accept only if `isInside(realRoot, real)`, where `isInside(base, target)` is `rel = path.relative(base, target); rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))`, using the path separator-aware check (`rel === ".." || rel.startsWith(".." + path.sep)`).
5. Require the final target to be a regular file (`stat`), else `invalid-path`.

`resolveOutput(name)`:

1. Same string checks. Reject names that are absolute or contain `..` segments after normalization (`path-outside-root`).
2. `target = path.resolve(realOut, name)`. Find the deepest existing ancestor with `lstat`, `realpath` it, append the missing tail, and require `isInside(realOut, thatPath)` (this catches a symlinked directory inside the output folder pointing out).
3. If `target` exists: `lstat` it. A symbolic link is rejected (`path-outside-root`). A regular file is allowed only when `overwrite` is true (`file-exists` otherwise).
4. Return `{ target, relative }`. Writing uses `fs.writeFile(target, data, { flag: overwrite ? "w" : "wx" })`, so a race cannot overwrite.

The output dir itself must be inside the real root: `isInside(realRoot, outputDirResolvedViaDeepestAncestor)`.

Messages show paths relative to the root (`relativeToRoot`), never absolute paths.

## Error model

`ToolError extends Error { code: ErrorCode }`. `safe(handler)` wraps every handler: it catches `ToolError` into `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] }` and any other exception into code `internal` with a generic message (the original message goes to stderr only as `tool=<name> status=internal`). Input is validated by the SDK from the zod shape, and a validation failure is mapped to `invalid-input` by a second check inside `safe` (the handler re-parses with `z.object(shape).safeParse`), so the structured code is consistent.

## Result format

Every success returns one text content item holding JSON (`JSON.stringify(value)`), plus, for `autopsy`, a second text item with the Markdown summary. `structuredContent` is also set to the same object so clients that read it get typed data. Rows are truncated to `MCP_RESULT_MAX_ROWS` with `{ truncated, totalRows }`.

## Tools: schemas and mapping to core

| Tool | Input (zod) | Core functions reused | Output |
| --- | --- | --- | --- |
| `frankendata_load_files` | `paths: string[1..10]` | `PathGuard.resolveInput`, `createIntakeController().intake`, `IntakeStore` | `tables[{tableName, sourceFileName, rowCount, columns[{name,type}]}]`, `failures[{path, code, message}]` |
| `frankendata_autopsy` | `table: string` | `runAutopsy(db, target, { allowFixes: false })`, `toMarkdown` | `report` (JSON) and Markdown item |
| `frankendata_propose_stitch` | `tables?: string[]` | `StitchController.computeProposals` (no AI provider) | `matches`, `cleanings`, `aiUsed: false`, `datasetVersion` |
| `frankendata_apply_stitch` | `approvedIds: string[]`, `anchor?`, `joinKeys?: Record<string,string>` | `assembleStitchPlan`, `StitchController.applyPlan`, `computeDatasetVersion` | `resultTable`, `rowCount`, `schema`, `fanOut`, `rows`, `createdTables` |
| `frankendata_apply_recipe` | `path: string` | `PathGuard`, `applyRecipeText`, `applyRecipeOverrides`, `assembleStitchPlan`, `applyPlan` | as apply_stitch plus `preApproved`, `notApplied`, `tableMap` |
| `frankendata_query` | `sql: string` | `validateSql`, `wrapWithFetchCap`, `createDuckDbQueryRunner`, `toDisplayRows`, `discoverStitchTables` | `columns`, `rows`, `rowCount`, `truncated` |
| `frankendata_export` | `table`, `format: "csv"\|"xlsx"`, `fileName?`, `overwrite?` | `exportTable`, `exportFileName`, `PathGuard.resolveOutput` | `path`, `bytes`, `format` |
| `frankendata_reset` | none | `dropAllTables`, `StitchController.undo`, store resets | `dropped: string[]` |

Details:

- **load_files**: each path is resolved by the guard. Passing files are read with `fs.readFile` (read-only) and wrapped as `new File([bytes], basename)` (Node provides `File`). A guard or read failure goes to `failures` and the others continue. All passing files go in one `intake()` call so name de-duplication works as in the web app. Intake errors in the store (`IntakeStore.getState().errors`) are copied to `failures` and then cleared for the next call. If no file passes the guard, the tool returns a ToolError for the first failure.
- **autopsy**: looks up the table among loaded tables and stitched tables (`discoverStitchTables`), builds `{ tableName, schema, rowCount }`, and runs `runAutopsy`.
- **propose_stitch**: sets `selection.names`, calls `computeProposals`, returns the ids and fields. The store keeps the `ProposalSet` and the `datasetVersion`.
- **apply_stitch**: checks `proposals !== null` (`no-proposals`), `computeDatasetVersion(selected tables) === store.getDatasetVersion()` (`proposals-stale`), then that every approved id is a proposal id (`unknown-proposal`). It builds decisions `{ proposalId, decision: "approved" }` for ONLY the passed ids and calls `assembleStitchPlan(proposals, decisions, tables, { anchorTableName, joinKeysByPair })`. A supplied `anchor` must be a loaded table, and each join key's match id must be among the approved matches. Then `applyPlan`. Nothing else is approved.
- **apply_recipe**: reads the recipe text through the guard and calls `applyRecipeText(text, { tables, store, computeProposals })`. On `ok:false` it returns `invalid-recipe` with the first 5 issues. On success it assembles the plan from the store state (decisions recorded by the apply step), applies `applyRecipeOverrides`, then `applyPlan`.
- **query**: `validateSql(sql, queryableNames)` first. A rejection returns `sql-rejected` with the reason and never calls the DuckDB service. An accepted statement goes through `wrapWithFetchCap`, `createDuckDbQueryRunner`, and `toDisplayRows`. Errors become `query-failed`.
- **export**: `exportTable(db, table, format)` returns the file content. The guard resolves the target inside the output dir. The file is written with the `wx` or `w` flag.

## Node DuckDB

`node-duckdb.ts` copies the technique in `src/core/recipes/duckdb-test-harness.ts`: `createRequire(import.meta.url)` loads `@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs`, `createDuckDB(bundles, new VoidLogger(), NODE_RUNTIME)`, `instantiate()`, `open({ path: ":memory:" })`, `connect()`, and an adapter `run(sql) => conn.query(sql).toArray().map(r => r.toJSON())` passed to `createDuckDBService(adapter)`. Row values can contain `bigint`; the existing converters handle them, and `jsonResult` converts any remaining `bigint` to a number or string.

The bundle files are resolved with `require.resolve` at runtime, so the built `server.js` finds them in `node_modules`.

## Kiro configuration

`.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "frankendata": {
      "command": "node",
      "args": ["mcp/dist/server.js"],
      "env": { "FRANKENDATA_MCP_ROOT": "." },
      "disabled": false
    }
  }
}
```

`"."` resolves to the server's working directory, which is the workspace root when Kiro starts it. The README explains `npm run mcp:build` first.

## Error handling summary

Guard failures: `invalid-path`, `path-outside-root`, `file-not-found`, `file-exists`. Table lookups: `table-not-found` (message lists loaded names). Proposal state: `no-proposals`, `proposals-stale`, `unknown-proposal`. Recipe: `invalid-recipe`. SQL: `sql-rejected`, `query-failed`. Export: `export-failed`. Anything unexpected: `internal`.

## Correctness properties and tests

| Property | Test file |
| --- | --- |
| 1 path guard never accepts outside the root (traversal, absolute, NUL, symlinks) | `mcp/src/path-guard.property.test.ts` |
| 2 query never executes a rejected statement | `mcp/src/tools/query.property.test.ts` |
| 3 apply_stitch leaves originals unchanged | `mcp/src/tools/apply-stitch.property.test.ts` |
| 4 parity with the web app core on the demo files | `mcp/src/parity.duckdb.test.ts` |

Other tests: `path-guard.test.ts`, one test file per tool handler (invalid input, success, each error code), `session.test.ts`, `fixtures.test.ts` (fixtures equal the bundled demo strings), and the end-to-end test `mcp/src/e2e.test.ts` using the SDK's `InMemoryTransport.createLinkedPair()` with a `Client`: load the two mismatched CSVs, autopsy, propose_stitch, apply_stitch with all proposal ids, query the most common species in the stitched result (expect Swamp Wraith with 3), export CSV to a temporary output folder, and confirm the file exists and original files are unchanged.

## Feasibility gate

Task 1 proves that the server boots over stdio and `load_files` works on the demo CSVs under Node, using a real subprocess smoke test. If the DuckDB node bundle or the core bundling cannot run under the built server, the run stops there and `NOTES.md` records exactly what failed.
