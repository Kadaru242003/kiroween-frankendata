# MCP server: run notes

## Summary

A local stdio MCP server (`mcp/`) that exposes the FrankenData engine to AI agents such as Kiro. Eight tools: `frankendata_load_files`, `_autopsy`, `_propose_stitch`, `_apply_stitch`, `_apply_recipe`, `_query`, `_export`, `_reset`. Everything reuses `src/core` through public functions: the intake pipeline, `runAutopsy`, the stitch controller (rules only), the applier, the recipe validator and mapper, the SQL validator with its fetch cap, and `exportTable`. One in-memory DuckDB per process, created from the same node-blocking bundle the tests use. No network, no AI.

Feasibility gate: passed early. The built `mcp/dist/server.js` boots over stdio in a real subprocess and `load_files` loads the demo CSVs (see `mcp/src/stdio.smoke.test.ts`).

The web app is unaffected: `mcp/` has its own `tsconfig`, is not included by `tsconfig.app.json` or the Vite build, and the new dependencies are devDependencies.

## Decisions made without asking

- **Bundling**: the server is bundled with Vite's SSR build through its JS API (`mcp/build.mjs`), because `src/core` uses extensionless imports that Node ESM cannot run. This adds no dependency. Packages stay external and load from `node_modules` at runtime, so `mcp:build` must run in a checkout where `npm install` has been done. The browser-only `?url` DuckDB asset imports are marked external because the server injects its own node connection.
- **Dependencies**: `@modelcontextprotocol/sdk@1.32.2` and `zod@4.6.7`, exact pinned, devDependencies.
- **`invalid-input` code**: the SDK validates input itself and returns a plain-text error. The server overrides the SDK's `createToolError` on the instance (a small cast) so validation failures return the structured `{ error: { code: "invalid-input" } }` shape. Handlers never throw, so only validation and unknown-tool errors reach it.
- **Serialized calls**: every tool body runs through `session.run`, because the node DuckDB instance is single threaded and the stores are shared.
- **Query rows**: the existing validator adds `LIMIT 1000` when a query has none, so `rowCount` of an unbounded query is at most 1000. The fetch cap wrapper (`ASK_MAX_FETCH_ROWS`) stays as the hard ceiling. Inline rows are limited to 200 with `truncated: true`.
- **apply_stitch** approves only the ids passed in. It requires proposals from a prior `propose_stitch` and rejects stale proposals (loaded tables changed). `joinKeys` entries must name an approved match id. Edits to canonicals are not exposed (approve or not).
- **Recipe replay** sets the selection to all loaded tables, runs `applyRecipeText`, assembles the plan from the store, applies `applyRecipeOverrides`, then `applyPlan`.
- **Reset** returns the table names present before dropping (including `stitch_` tables) and clears the intake and stitch stores. Files on disk, including exports, are untouched.
- **Export** is limited to the output folder (default `frankendata-output` in the root). It writes with the `wx` flag unless `overwrite` is true, and refuses symbolic link targets and links that lead outside the folder. The file name must end in the chosen extension.
- **Path guard** resolves against the real root and compares real paths, so a symlink anywhere in the path that leaves the root is rejected. Messages show root-relative paths only.
- **Test files** in `mcp/` run under `npm test` (added to the `include` list in `vitest.config.ts`) with `// @vitest-environment node`.
- **Fixtures**: `mcp/fixtures/monsters.csv` and `experiments.csv` are the mismatched demo files, and a test asserts they equal the bundled demo strings.
- This branch was created from the tip of the `recipes` branch, so it includes the recipes feature (the tools use it). `git checkout main` and `git pull` were interrupted earlier, so main may not have the recipes work.

## Tiny additive edits to existing files

- `vitest.config.ts`: the `include` list gains `mcp/**/*.{test,spec}.ts`.
- `package.json`: `mcp:build` and `mcp:start` scripts, two devDependencies.
- `.gitignore`: `mcp/dist` and `frankendata-output`.
- No change to any `src/core` module, `api/`, existing specs or steering docs.

## Deviations

- Requirement 1.4 asks for `invalid-input` on bad input. It is delivered through the `createToolError` override described above rather than by the handlers.
- Requirement 5.1 says match proposals need at least two tables. The tool does not enforce this itself. With one table the existing engine simply returns no matches (cleanups still return).
- Requirement 6.5 mentions "the first rows": `apply_stitch` returns up to 200 rows inline and a `truncated` flag.
- `MCP_MAX_FILE_BYTES`, `MCP_MAX_RECIPE_BYTES` and `MCP_QUERY_MAX_ROWS` are not redefined in `limits.ts`. The existing intake size check, `RECIPE_MAX_BYTES` and `ASK_MAX_FETCH_ROWS` are used directly.

## Known issues

- The server loads the tools' dependencies from `node_modules` at runtime, so `mcp/dist/server.js` cannot be copied elsewhere on its own.
- The first tool call pays the DuckDB start-up cost (about a second).
- `propose_stitch` with the optional `tables` subset applies the subset to later `apply_stitch` calls too; call `propose_stitch` again to change it.
- The in-memory test transport and a stdio subprocess are both covered, but a real Kiro session was not run in this environment, so the Kiro config file is untested in the IDE.
- Lint reports warnings only (the existing web app ones).

## Exact manual test steps (Kiro chat)

1. `npm install`, then `npm run mcp:build`.
2. Open the repo in Kiro. Open the MCP Server view and confirm `frankendata` is listed and connected (reconnect it if needed). If the server does not start, run `npm run mcp:start` in a terminal to see stderr.
3. In chat: "Use FrankenData to load mcp/fixtures/monsters.csv and mcp/fixtures/experiments.csv." Expect two tables: monsters (14 rows) and experiments (13 rows), with typed columns (Sedated and hazardous are boolean).
4. "Run an autopsy on monsters." Expect health score 81 and 2 duplicate rows.
5. "Propose a stitch." Expect a Monster_Name to monster_name match and cleanups for Species and duplicates.
6. "Apply all of those proposals." Expect `stitch_1_result` with 12 rows.
7. "Which species is most common in the stitched result?" Expect Swamp Wraith with 3.
8. "Export the stitched table to CSV." Expect `frankendata-output/stitch_1_result.csv`. Ask again: expect a refusal until overwrite is requested.
9. Try "Load ../../etc/passwd": expect a path-outside-root error.
10. "Reset FrankenData." Expect all tables dropped; the exported file is still on disk.

## Verification

- `npm test`: 141 files, 896 tests passing (about 42 new, in `mcp/`).
- `npm run build`, `npm run check:api`, `npm run mcp:build`: pass. `npm run lint`: warnings only, no errors.
- Properties: path guard (traversal, absolute, NUL, symlinks), query respects the validator (DuckDB spy), originals unchanged after any approved subset, and parity with the web app core on the demo files.

## Credits used

About 150 of the 350 budget (an estimate; I have no exact meter).
