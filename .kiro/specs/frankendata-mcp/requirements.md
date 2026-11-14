# Requirements Document

## Introduction

FrankenData is a client-side, browser-only web application for the Kiroween 2026 hackathon (Frankenstein category). Features 1 to 5 (`.kiro/specs/frankendata-file-intake`, `frankendata-ai-stitching`, `frankendata-chat-sql`, `frankendata-autopsy`, `frankendata-recipes`) load messy files into typed in-memory DuckDB tables, propose and apply stitches and cleanups, answer read-only SQL, report data quality, and save and replay recipes. All of that logic lives in framework-agnostic modules under `src/core`.

This specification covers Feature 6: **a local MCP server** that exposes the FrankenData engine to AI agents such as Kiro. The server speaks the Model Context Protocol over stdio, runs under Node, and reuses the existing `src/core` modules through their public functions. The server is a developer tool that runs on the user's own machine. It makes no network call, calls no AI, and the web app and its Vercel deployment are unaffected by it.

The server lives in its own folder, `mcp/`, with its own TypeScript configuration. It is excluded from the Vite build and from `tsconfig.app.json`. Its dependencies are `devDependencies`, so nothing reaches the browser bundle.

Out of scope: any AI call, HTTP or network transports, authentication, persistence between server runs, editing source files, and any change to the web app.

## Glossary

- **FrankenData**: The client-side web application built for the Kiroween 2026 hackathon.
- **MCP**: The Model Context Protocol.
- **McpServer**: The stdio server in `mcp/` that registers the tools below.
- **Tool**: One MCP tool. Every tool name starts with `frankendata_`.
- **Session**: The in-memory state of one server process: one DuckDB instance, the intake store, the stitch store, and the controllers. It is discarded when the process ends.
- **AllowedRoot**: The directory every input and output path must stay inside. The default is the current working directory. The `FRANKENDATA_MCP_ROOT` environment variable overrides it.
- **OutputFolder**: The directory exports are written to. The default is `<AllowedRoot>/frankendata-output`.
- **PathGuard**: The pure-Node module that resolves and checks every path before any file system access.
- **LoadedTable**: A table loaded by Feature 1 (`src/core/types.ts`).
- **StitchedTable**: A `stitch_<n>_result` table created by the existing applier.
- **Recipe**: A FrankenData recipe JSON (Feature 5).
- **SqlValidator**: The existing read-only SQL validator `validateSql` (`src/core/chat/sql-validator.ts`).
- **ToolError**: The structured error result every tool returns on failure: `{ error: { code, message } }` with the MCP `isError` flag set.
- **TestSuite**: The automated tests, including `fast-check` property tests.

## Named Constants

These SHALL be named values in `mcp/src/limits.ts`.

- **MCP_MAX_FILES = 10** - The most files one `load_files` call accepts.
- **MCP_MAX_FILE_BYTES** - The existing intake size limit (`checkSize`), reused, not redefined.
- **MCP_MAX_RECIPE_BYTES** - The existing `RECIPE_MAX_BYTES`, reused.
- **MCP_DEFAULT_OUTPUT_DIR = "frankendata-output"** - The default output folder name inside the root.
- **MCP_QUERY_MAX_ROWS** - The existing `ASK_MAX_FETCH_ROWS`, reused.
- **MCP_RESULT_MAX_ROWS = 200** - The most rows a tool result returns inline. A larger result is truncated with `truncated: true` and the total row count.

## Requirements

### Requirement 1: Server startup and protocol

**User Story:** As a Kiro user, I want a local MCP server I can register in one config file, so that the agent can use the FrankenData engine.

#### Acceptance Criteria

1. THE McpServer SHALL start with `node mcp/dist/server.js` and communicate over stdio using the MCP SDK's stdio transport.
2. THE McpServer SHALL write protocol messages only to stdout and SHALL write any diagnostics only to stderr, so stdout stays a clean protocol channel.
3. THE McpServer SHALL register exactly these tools: `frankendata_load_files`, `frankendata_autopsy`, `frankendata_propose_stitch`, `frankendata_apply_stitch`, `frankendata_apply_recipe`, `frankendata_query`, `frankendata_export`, `frankendata_reset`.
4. EVERY tool SHALL declare an input schema, validated before the handler runs. A call with invalid input SHALL return a ToolError with code `invalid-input` and SHALL NOT change the Session.
5. THE McpServer SHALL create its Session lazily on the first tool call and SHALL create a single DuckDB instance per process, using the same node-blocking DuckDB-WASM bundle the existing tests use.
6. THE McpServer SHALL make no network request of any kind and SHALL NOT call any AI provider. THE server code SHALL NOT import the AI provider, the AI proxy, or the SQL provider modules.
7. THE McpServer SHALL be exportable as a factory (`createFrankenDataServer`) that can be connected to any transport, so tests can run it in-process.

### Requirement 2: Path safety

**User Story:** As a user, I want the server to touch only the files I allow, so that an agent cannot read or overwrite anything else.

#### Acceptance Criteria

1. THE PathGuard SHALL resolve every input path against the AllowedRoot (relative paths are relative to the root) and SHALL accept it only when the real path (after resolving all symbolic links) is inside the real AllowedRoot.
2. THE PathGuard SHALL reject, with code `path-outside-root`: any path that resolves outside the root (including `..` segments), an absolute path outside the root, and a path whose real location is outside the root because of a symbolic link anywhere in the path (file or directory).
3. THE PathGuard SHALL reject paths containing a NUL character, empty paths, and paths that are not strings, with code `invalid-path`.
4. FOR an output path that does not exist yet, THE PathGuard SHALL resolve the deepest existing ancestor with `realpath`, append the remaining segments, and require the result to be inside the OutputFolder. THE OutputFolder SHALL itself be inside the AllowedRoot and SHALL be created on demand.
5. THE input files SHALL be opened for reading only. No tool SHALL modify, rename, or delete an input file.
6. THE `export` tool SHALL refuse to write over an existing file unless the caller passes `overwrite: true`, and SHALL refuse to write through a symbolic link. A refusal returns a ToolError with code `file-exists` or `path-outside-root`.
7. THE export file name SHALL be a plain file name or a relative path inside the OutputFolder, and SHALL end in `.csv` or `.xlsx` matching the requested format.

### Requirement 3: `frankendata_load_files`

**User Story:** As an agent, I want to load CSV and XLSX files into the session, so that I can analyze them.

#### Acceptance Criteria

1. THE tool SHALL accept `paths: string[]` (1 to `MCP_MAX_FILES` entries) and pass each path through the PathGuard before reading it.
2. THE tool SHALL read each file into a `File` object and route all files through the existing `IntakeController.intake`, so detection, size check, parsing, type inference, name sanitization, and typed DuckDB table creation are exactly the web app's.
3. THE result SHALL list each loaded table with `tableName`, `sourceFileName`, `rowCount`, and `columns` (name and type), and SHALL list per-file failures with the file name, the intake error kind, and its message. A failing file SHALL NOT prevent the others from loading.
4. WHEN a path fails the PathGuard or cannot be read, THE tool SHALL report that file in the failures list (code `path-outside-root`, `invalid-path`, or `file-not-found`) and SHALL continue with the other files. IF no file passes the guard, THE tool SHALL return a ToolError.
5. Loading files SHALL NOT drop existing tables. Name collisions get the existing numeric suffix.

### Requirement 4: `frankendata_autopsy`

**User Story:** As an agent, I want a data quality report for a table, so that I can tell the user what is wrong with it.

#### Acceptance Criteria

1. THE tool SHALL accept `table: string` naming a loaded table or a stitched result.
2. THE tool SHALL run the existing `runAutopsy` and return the report as structured JSON (health score, breakdown, table findings, per-column findings, status) plus a short Markdown summary produced by the existing `toMarkdown`.
3. IF the table does not exist, THE tool SHALL return a ToolError with code `table-not-found` that lists the available table names.
4. THE tool SHALL NOT modify any table. Fix it actions SHALL be omitted from the result (`allowFixes: false`).
5. FOR the same table and data, the result SHALL equal the web app core result (`runAutopsy` with the same arguments).

### Requirement 5: `frankendata_propose_stitch`

**User Story:** As an agent, I want the deterministic stitch proposals, so that I can show the user what could be matched and cleaned.

#### Acceptance Criteria

1. THE tool SHALL accept an optional `tables: string[]` (default: all loaded tables) and SHALL require at least two tables for match proposals; cleanup proposals are returned for one or more tables.
2. THE tool SHALL run the existing `StitchController.computeProposals` with NO AI provider and SHALL return the matches (id, left and right column, confidence, reason) and the cleanups (id, kind, table, column, reason, canonical), plus `aiUsed: false` and the `datasetVersion`.
3. THE tool SHALL store the proposals in the Session so a later `apply_stitch` can refer to their ids.
4. THE result SHALL be deterministic for the same loaded tables.
5. THE tool SHALL NOT apply anything and SHALL NOT change any table.

### Requirement 6: `frankendata_apply_stitch`

**User Story:** As an agent, I want to apply exactly the plan I and the user agreed on, so that nothing is changed implicitly.

#### Acceptance Criteria

1. THE tool SHALL accept `approvedIds: string[]` (proposal ids from the last `propose_stitch`), an optional `anchor: string`, and an optional `joinKeys: Record<string, string>` (table pair key to approved match id).
2. THE tool SHALL apply ONLY the proposals whose ids are listed in `approvedIds`. IT SHALL NEVER approve, apply, or include a proposal that was not passed in.
3. THE tool SHALL reject with a ToolError: no proposals computed yet (`no-proposals`); the loaded tables changed since the proposals were computed (`proposals-stale`); an unknown id (`unknown-proposal`); an `anchor` that is not a loaded table; a join key that does not name an approved match.
4. THE tool SHALL build the plan with the existing `assembleStitchPlan` and apply it with the existing `StitchController.applyPlan` and applier. Original tables SHALL remain unchanged (the applier only creates `stitch_` tables).
5. THE result SHALL include the result table name, row count, schema (name and type), the fan-out counts, and the first rows (up to `MCP_RESULT_MAX_ROWS`).
6. A second apply SHALL create new `stitch_<n>_*` tables with the next counter and SHALL leave the earlier ones in place.

### Requirement 7: `frankendata_apply_recipe`

**User Story:** As an agent, I want to replay a saved recipe on new files, so that a monthly job is one call.

#### Acceptance Criteria

1. THE tool SHALL accept `path: string` of a recipe JSON file, pass it through the PathGuard, and read it as text.
2. THE tool SHALL run the existing `applyRecipeText` (validator, mapper, proposal recompute, decisions) and then apply the resulting plan, using `applyRecipeOverrides` for the anchor and keys and `StitchController.applyPlan`.
3. WHEN the recipe is invalid, THE tool SHALL return a ToolError with code `invalid-recipe` listing up to 5 problems with their paths, and SHALL change nothing.
4. THE result SHALL include the same fields as `apply_stitch` plus `preApproved` (count), `notApplied` (kind, description, code, reason), and the table mapping.
5. A recipe SHALL contain no SQL and no row values; the tool SHALL NOT execute any text from the recipe other than through the existing mapper and applier.

### Requirement 8: `frankendata_query`

**User Story:** As an agent, I want to run read-only SQL over the session tables, so that I can answer questions about the data.

#### Acceptance Criteria

1. THE tool SHALL accept `sql: string`.
2. THE tool SHALL pass the SQL through the existing SqlValidator with the current queryable table names (loaded tables and present `stitch_` tables) BEFORE any DuckDB execution. A rejected statement SHALL return a ToolError with code `sql-rejected` and the validator's reason, and SHALL NOT reach DuckDB.
3. THE tool SHALL execute the accepted SQL wrapped with the existing fetch cap (`wrapWithFetchCap`, `ASK_MAX_FETCH_ROWS`) and convert the rows with the existing result converter, so values are plain strings, numbers, and booleans.
4. THE result SHALL include `columns`, `rows` (up to `MCP_RESULT_MAX_ROWS`), `rowCount`, and `truncated`.
5. A DuckDB runtime error SHALL return a ToolError with code `query-failed` and the message.

### Requirement 9: `frankendata_export`

**User Story:** As an agent, I want to save a table to disk, so that the user can open it.

#### Acceptance Criteria

1. THE tool SHALL accept `table: string`, `format: "csv" | "xlsx"`, an optional `fileName: string`, and an optional `overwrite: boolean` (default false).
2. THE tool SHALL produce the file with the existing `exportTable` (full table, not a preview) and write it inside the OutputFolder after the PathGuard checks. THE default file name SHALL be the existing safe name `exportFileName(table, format)`.
3. THE tool SHALL create the OutputFolder when it does not exist and SHALL NOT write anywhere else.
4. THE result SHALL include the written path relative to the AllowedRoot, the byte size, and the format.
5. THE tool SHALL NOT overwrite an existing file without `overwrite: true` (Requirement 2.6).

### Requirement 10: `frankendata_reset`

**User Story:** As an agent, I want a clean slate, so that I can start a new analysis.

#### Acceptance Criteria

1. THE tool SHALL drop every table in the session (originals, cleaned copies, results), clear the intake store and the stitch store, and return the dropped names.
2. THE tool SHALL NOT touch any file on disk, including exported files and input files.
3. After a reset, `load_files` SHALL work again and table names start fresh.

### Requirement 11: Errors

**User Story:** As an agent, I want clear structured errors, so that I can correct my call.

#### Acceptance Criteria

1. EVERY failure SHALL return a ToolError `{ error: { code, message } }` with `isError: true`. A handler SHALL NOT throw to the protocol layer and SHALL NOT crash the server.
2. THE codes SHALL come from a fixed set: `invalid-input`, `invalid-path`, `path-outside-root`, `file-not-found`, `file-exists`, `table-not-found`, `no-proposals`, `proposals-stale`, `unknown-proposal`, `invalid-recipe`, `sql-rejected`, `query-failed`, `export-failed`, `internal`.
3. Error messages SHALL NOT include file contents or row values. Paths in messages SHALL be shown relative to the AllowedRoot.
4. THE server SHALL log nothing to stdout, and SHALL log only coarse metadata (tool name, status, counts) to stderr, never row values or SQL text.

### Requirement 12: Integration with Kiro

**User Story:** As a Kiro user, I want to switch the server on with one config file.

#### Acceptance Criteria

1. THE repository SHALL contain a workspace MCP config at `.kiro/settings/mcp.json` that registers a `frankendata` server with `command: "node"` and `args: ["mcp/dist/server.js"]`, and an `env` entry for `FRANKENDATA_MCP_ROOT`.
2. THE `package.json` SHALL define `mcp:build` and `mcp:start` scripts. `mcp:build` SHALL type-check the server with its own tsconfig and bundle it to `mcp/dist/server.js`.
3. THE README SHALL contain a section "Use FrankenData from Kiro (MCP)" with setup steps and three example prompts.
4. THE build output `mcp/dist` SHALL be gitignored.

### Requirement 13: Isolation from the web app

**User Story:** As the maintainer, I want the MCP server to be unable to break the web app or its deployment.

#### Acceptance Criteria

1. THE MCP server code SHALL live only in `mcp/`, with its own `tsconfig`, and SHALL NOT be included by `tsconfig.app.json`, the Vite build, or `api/`.
2. THE MCP dependencies SHALL be `devDependencies` pinned to exact versions. No other dependency SHALL be added.
3. `npm run build`, `npm run check:api`, and the full `npm test` SHALL pass unchanged in behavior.
4. THE server SHALL NOT change the behavior of any existing `src/core` module. Any tiny additive export SHALL be listed in `NOTES.md`.
5. THE MCP tests SHALL run under `npm test` in a Node environment.

### Requirement 14: Correctness properties for property-based tests

**User Story:** As a developer, I want the safety properties checked by property-based tests.

#### Acceptance Criteria

1. **Property 1 (path guard)**: FOR ANY candidate path string (including `../` sequences, absolute paths, NUL bytes, and paths through symbolic links that leave the root), THE PathGuard SHALL never return a path whose real location is outside the AllowedRoot.
2. **Property 2 (query)**: FOR ANY SQL string, THE query tool SHALL NOT execute any statement that the SqlValidator rejects. A spy on the DuckDB service SHALL see no call for a rejected statement.
3. **Property 3 (originals unchanged)**: FOR ANY approved subset of proposals, `apply_stitch` SHALL leave every original table's rows and schema unchanged, and SHALL create only `stitch_` tables.
4. **Property 4 (parity)**: FOR the bundled demo files, the MCP results (loaded tables, autopsy report, proposals, stitched result) SHALL equal the results of calling the web app core directly with the same inputs.
5. EACH property test SHALL reference its design property by tag in its header comment (**Feature: frankendata-mcp, Property {n}: {title}**).
