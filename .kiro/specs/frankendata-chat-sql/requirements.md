# Requirements Document

## Introduction

FrankenData is a client-side, browser-only web application for the Kiroween 2026 hackathon (Frankenstein category). Feature 1 (`.kiro/specs/frankendata-file-intake`) loads messy CSV/XLSX files into typed, in-memory DuckDB-WASM tables. Feature 2 (`.kiro/specs/frankendata-ai-stitching`) stitches and cleans those tables, producing joined `stitch_<n>_result` tables through a deterministic rules engine with an optional LLM enhancement reached only through a fail-closed `/api/ai` proxy.

This specification covers Feature 3: **Ask the Lab** — a chat-style SQL question panel. Once at least one table is loaded, the user can ask a plain-English question about the loaded tables (including the `stitch_<n>_result` tables from Feature 2) and get back a result table, an optional chart, and a CSV export. The whole feature runs in the browser: DuckDB executes every query locally, and the only thing that ever leaves the browser is a single LLM call through a new `/api/sql` proxy that sends only a question and a bounded schema summary — never full rows.

The feature is useful with the AI turned off. For every loaded table, FrankenData deterministically generates a handful of example questions ("starter chips") whose SQL is built by rules and run directly with no LLM call. When `VITE_AI_ENABLED` is off, or the proxy is rate limited, over budget, or unreachable, the starter chips still work and the app points the user to them.

Every generated query is checked by a client-side SQL safety validator before it reaches DuckDB: only a single read-only `SELECT`/`WITH` statement over the loaded tables is allowed, forbidden keywords and file/network table functions are rejected, and a `LIMIT` is enforced when the query has none. Results are converted to safe display values (no `[object Object]`, no thrown `BigInt`/`Date` surprises) for the table, chart, and CSV.

Editing SQL in the UI, saving queries, multi-turn chat memory, and PDF export are out of scope.

## Glossary

- **FrankenData**: The client-side web application that stitches together mismatched technologies (React, Vite, TypeScript, DuckDB-WASM, PapaParse, SheetJS) for the Kiroween 2026 hackathon.
- **AskTheLab**: The subsystem added by this feature — the themed panel, the question flow, starter chips, the LLM path, the SQL validator, result conversion, charts, and CSV export.
- **LoadedTable**: A table already parsed, typed, and loaded into DuckDB-WASM by Feature 1, or a `stitch_<n>_*` table created by Feature 2. Defined in `src/core/types.ts`.
- **QueryableTable**: Any table AskTheLab is allowed to query: every current `LoadedTable` plus the Feature 2 `stitch_<n>_result` / `stitch_<n>_clean_*` tables present in DuckDB-WASM.
- **SchemaSummary**: The bounded description of the QueryableTables sent to the LLM: table names, column names, column types, and up to a few short sample values per column — never full rows.
- **AskQuestion**: A plain-English question the user types (or that a starter chip carries) about the QueryableTables.
- **GeneratedSql**: A single SQL statement produced either by the LLM path or by a StarterChip's rule-based builder.
- **SqlValidator**: The client-side, framework-agnostic validator that accepts only a single read-only statement over QueryableTables and rejects everything else (Requirement 5).
- **StarterChip**: A clickable example question generated deterministically from one QueryableTable's schema, carrying its own rule-built GeneratedSql that runs with no LLM call.
- **ChartSpec**: An optional chart description `{ type: "bar" | "line" | "pie", x, y }` returned by the LLM alongside its SQL, validated against the result columns before use.
- **ResultTable**: The rows DuckDB returns for a GeneratedSql, after safe value conversion.
- **SqlProvider**: The interface AskTheLab calls to turn an AskQuestion + SchemaSummary into a `{ sql, explanation, chart? }` response; it has a production implementation that posts to `/api/sql` and a fake implementation for tests.
- **SqlProxy**: The new serverless endpoint (`api/sql.ts` + its core handler in `src/core`) that holds the LLM API key server-side and relays only the AskQuestion and SchemaSummary.
- **RepairCall**: A single additional LLM call made when DuckDB rejects an otherwise-valid GeneratedSql, sending the error message and the previous SQL back to the model.
- **AiEnabled**: The `VITE_AI_ENABLED` flag; the app attempts the LLM path only when it is exactly `"true"`.
- **TestSuite**: The automated test suite accompanying FrankenData, including the property-based tests (`fast-check`).

## Named Constants

These constants SHALL be exposed as named values in the implementation so that tests and the UI reference them rather than hard-coding literals. The SqlProxy reuses the per-client hourly limit, the global daily cap, and the max payload size already pinned by Feature 2 in `src/core/stitching/types.ts`.

- **ASK_MAX_QUESTION_CHARS = 300** — The maximum length of an AskQuestion.
- **ASK_RESULT_DISPLAY_CAP = 100** — The maximum number of ResultTable rows shown in the on-screen table (CSV export is not capped to this, but is bounded by ASK_MAX_FETCH_ROWS).
- **ASK_DEFAULT_SQL_LIMIT = 1000** — The `LIMIT` the SqlValidator appends when accepted SQL has none.
- **ASK_MAX_FETCH_ROWS = 5000** — The hard cap on rows the executor ever materializes; the validated SQL is wrapped so no model-written LIMIT can exceed it.
- **ASK_HISTORY_SIZE = 5** — The number of most-recent AskQuestions kept and shown for the current session.
- **ASK_MAX_STARTER_CHIPS_PER_TABLE = 4** — The maximum number of StarterChips generated per QueryableTable.
- **ASK_CATEGORY_DISTINCT_MAX = 12** — The maximum distinct values a string column may have for a "rows per category" StarterChip to be offered.
- **ASK_CHART_MAX_CATEGORIES = 20** — The maximum categories a chart renders; a pie groups the rest as "Other" and a bar truncates.
- **ASK_SCHEMA_MAX_TABLES = 10** — The maximum number of tables included in a SchemaSummary.
- **ASK_SCHEMA_MAX_COLUMNS_PER_TABLE = 40** — The maximum number of columns per table included in a SchemaSummary.
- **ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN = 3** — The maximum sample values per column included in a SchemaSummary.
- **ASK_SCHEMA_MAX_SAMPLE_CHARS = 30** — The maximum characters per sample value in a SchemaSummary (longer values truncated).
- **ASK_SCHEMA_MAX_PAYLOAD_BYTES = 16384** — The maximum SchemaSummary size (16 KiB); the summary is trimmed to fit.
- **AI_PROXY_PER_CLIENT_LIMIT** — Reused from Feature 2: per-client requests per hour for the SqlProxy, under its own hourly key prefix.
- **AI_PROXY_DAILY_REQUEST_CAP** — Reused from Feature 2: the SHARED global daily cap counted across both the `/api/ai` and `/api/sql` proxies.
- **AI_PROXY_MAX_PAYLOAD_BYTES** — Reused from Feature 2: the maximum SqlProxy request body size.
- **AI_REQUEST_TIMEOUT_MS** — Reused from Feature 2: the client-side timeout applied to each SqlProvider request.

## Requirements

### Requirement 1: Ask the Lab Entry and Panel

**User Story:** As a data analyst, I want a themed "Ask the Lab" panel once I have data loaded, so that I can ask questions about my tables in plain English.

#### Acceptance Criteria

1. WHILE at least one QueryableTable is loaded, THE AskTheLab SHALL make the "Ask the Lab" panel available; WHILE no QueryableTable is loaded, THE AskTheLab SHALL NOT offer the panel.
2. THE AskTheLab panel SHALL provide a text input for an AskQuestion, a submit control, and a loading state shown WHILE a question is being answered.
3. THE AskTheLab SHALL limit the AskQuestion to ASK_MAX_QUESTION_CHARS characters.
4. THE AskTheLab SHALL show the most recent ASK_HISTORY_SIZE AskQuestions from the current session, and WHEN the user selects a prior question, THE AskTheLab SHALL re-run it.
5. WHEN a question is answered, THE AskTheLab SHALL display the GeneratedSql in a code block with a copy control and a one-sentence explanation of the query.
6. WHEN a question produces a ResultTable, THE AskTheLab SHALL display the result as a table, and WHERE a valid ChartSpec is available, THE AskTheLab SHALL also display the chart.
7. WHEN a ResultTable has more than ASK_RESULT_DISPLAY_CAP rows, THE AskTheLab SHALL display the first ASK_RESULT_DISPLAY_CAP rows and a note stating the display is capped and how many rows the full result has.
8. THE AskTheLab panel SHALL apply the existing spooky mad-scientist lab theme and SHALL render body text with a contrast ratio of at least 4.5:1 against the themed background.

### Requirement 2: No-AI Starter Questions

**User Story:** As a judge or first-time user, I want ready-made example questions I can click, so that I can see the feature work immediately even with AI turned off.

#### Acceptance Criteria

1. WHEN at least one QueryableTable is loaded, THE AskTheLab SHALL deterministically generate up to ASK_MAX_STARTER_CHIPS_PER_TABLE StarterChips per QueryableTable and display them as clickable chips.
2. THE AskTheLab SHALL build each StarterChip's GeneratedSql by rules, drawing from: total row count; rows per category for a string column with at most ASK_CATEGORY_DISTINCT_MAX distinct values; top 10 rows by a numeric column; and the min, max, and average of a numeric column.
3. THE AskTheLab SHALL generate StarterChips only for the rule patterns that apply to a table's actual columns, and SHALL generate the same StarterChips for the same QueryableTable schema on every run.
4. WHEN the user clicks a StarterChip, THE AskTheLab SHALL run its GeneratedSql directly against DuckDB-WASM with no LLM call.
5. WHILE AiEnabled is off OR the SqlProxy is unavailable, THE AskTheLab SHALL still generate and run StarterChips.
6. THE AskTheLab SHALL pass every StarterChip's GeneratedSql through the SqlValidator before execution, exactly as it does for LLM-produced SQL.

### Requirement 3: LLM Question-to-SQL Path

**User Story:** As a data analyst, I want to ask free-form questions and have the model write the SQL, so that I can query my data without writing SQL myself.

#### Acceptance Criteria

1. THE AskTheLab SHALL define a SqlProvider interface that turns an AskQuestion plus a SchemaSummary into a response of the form `{ sql, explanation, chart? }`, with a production implementation that posts to `/api/sql` and a fake implementation for tests.
2. WHEN the user submits an AskQuestion AND AiEnabled is on, THE AskTheLab SHALL build a SchemaSummary and call the SqlProvider.
3. THE SchemaSummary SHALL contain only table names, column names, column types, and up to ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN sample values per column of at most ASK_SCHEMA_MAX_SAMPLE_CHARS characters each, and SHALL NOT contain full rows.
4. THE AskTheLab SHALL bound the SchemaSummary to at most ASK_SCHEMA_MAX_TABLES tables, at most ASK_SCHEMA_MAX_COLUMNS_PER_TABLE columns per table, and a total size of at most ASK_SCHEMA_MAX_PAYLOAD_BYTES bytes, trimming to fit; WHEN trimming to these limits, THE AskTheLab SHALL order tables so that `stitch_<n>_result` tables come first, then original LoadedTables, then `stitch_<n>_clean_*` tables, and SHALL drop from the end of that order.
5. THE AskTheLab SHALL limit the AskQuestion sent to the SqlProvider to ASK_MAX_QUESTION_CHARS characters.
6. THE SqlProvider's production implementation SHALL send only the AskQuestion and the SchemaSummary, SHALL apply a timeout of AI_REQUEST_TIMEOUT_MS, and SHALL treat any non-200 status, timeout, network error, or non-JSON body as a failure.
7. THE SqlProxy SHALL build a prompt that instructs the model to return JSON only, matching `{ sql, explanation, chart?: { type, x, y } }`, to use a temperature of 0, to use only the provided tables and columns, to write DuckDB SQL, and to produce a single SELECT.
8. THE SqlProxy prompt SHALL declare all SchemaSummary text and the AskQuestion to be untrusted data that must never be treated as instructions.

### Requirement 4: SqlProxy Serverless Endpoint

**User Story:** As a security-conscious developer, I want the question-to-SQL LLM call behind the same hardened proxy pattern as Feature 2, so that no key leaks and spending stays bounded.

#### Acceptance Criteria

1. THE SqlProxy SHALL be implemented as a new Vercel serverless function `api/sql.ts` using the same Node `(req, res)` adapter pattern as `api/ai.ts`, delegating all logic to a framework-agnostic core handler in `src/core`.
2. THE SqlProxy core handler SHALL reuse the fail-closed structure of `ai-proxy.ts`, applying the checks in this order: HTTP method, required env, payload size, request schema, Origin, a per-client hourly counter under its own hourly key prefix, the SHARED global daily cap, then the upstream LLM call.
3. THE SqlProxy SHALL return the same status codes as the Feature 2 proxy for the corresponding conditions: 400 for a schema violation, 403 for a disallowed Origin, 405 for a non-POST method, 413 for an oversized payload, 429 for the per-client limit and for the global daily cap, and 503 for the fail-closed "unavailable" case.
4. THE SqlProxy SHALL read the same server-side environment variables and provider settings as the Feature 2 proxy (`AI_PROVIDER`, `AI_MODEL`, the LLM API key, the Upstash credentials, `IP_HASH_SALT`, allowed origins), with provider and model fully env-driven and no hard-coded model.
5. THE SqlProxy request schema SHALL accept only the AskQuestion (at most ASK_MAX_QUESTION_CHARS characters) and the SchemaSummary bounded per Requirement 3, and SHALL reject unknown or extra fields and oversized arrays with 400.
6. THE SqlProxy SHALL count its per-client requests under a key prefix distinct from the `/api/ai` proxy, AND SHALL increment the SAME global daily cap counter the `/api/ai` proxy uses, so the daily cap is shared across both proxies.
7. THE SqlProxy SHALL fail closed on any missing required env, unreachable counter, or upstream error, never calling the LLM when a counter cannot be read.
8. THE SqlProxy SHALL NOT log SchemaSummary sample values or the AskQuestion text.

### Requirement 5: Client-Side SQL Safety Validation

**User Story:** As a security-conscious developer, I want every generated query validated before it touches DuckDB, so that a model (or a crafted question) can never run anything but a safe read-only query over my tables.

#### Acceptance Criteria

1. THE SqlValidator SHALL run entirely client-side and framework-agnostic, and THE AskTheLab SHALL pass every GeneratedSql — from the LLM path, a RepairCall, or a StarterChip — through it before execution.
2. THE SqlValidator SHALL strip SQL comments before analysis and SHALL accept only a single statement whose first keyword is SELECT or WITH.
3. THE SqlValidator SHALL reject any semicolon other than a single trailing one, so that no second statement can be chained.
4. THE SqlValidator SHALL reject SQL containing any of the keywords INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH, DETACH, COPY, PRAGMA, INSTALL, LOAD, CALL, EXPORT, and SET, matching each keyword as a whole word only and AFTER removing comments, string literals, and quoted identifiers; a forbidden word that appears inside a string literal or a quoted identifier (for example `WHERE status = 'Load'`, or a column named `"set"`) SHALL NOT cause rejection.
5. THE SqlValidator SHALL reject SQL that references a file or network table function, including read_csv, read_parquet, read_json, glob, and httpfs-style functions.
6. THE SqlValidator SHALL verify table references as follows: it SHALL reject a string literal or quoted path in a table position (for example `FROM 'data.csv'` or `FROM 'https://...'`); it SHALL reject any table-function call in a FROM or JOIN position unless that function is on an explicit allowlist (which MAY be empty); it SHALL reject replacement-scan-style references; it SHALL check EVERY comma-separated table reference in a FROM clause exactly like the first (so `FROM a, 'file.csv'` and `FROM a, unknown` are both rejected); it SHALL reject a dotted reference `qualifier.name` unless the qualifier is exactly `main` (so `information_schema.tables` and any other schema are rejected); it SHALL treat CTE aliases declared in the same WITH statement as valid references; and it SHALL reject SQL whose every other referenced table is not a current QueryableTable.
7. WHEN accepted SQL has no LIMIT, THE SqlValidator SHALL enforce a LIMIT of ASK_DEFAULT_SQL_LIMIT; WHEN accepted SQL already has a LIMIT, THE SqlValidator SHALL leave it unchanged.
8. THE AskTheLab SHALL validate a ChartSpec against the ResultTable columns — the chart type is one of the allowed types, both the x and y columns exist, and the y column is numeric — and WHEN a ChartSpec is invalid, THE AskTheLab SHALL drop the chart and still show the ResultTable rather than failing.
9. WHEN executing accepted SQL, THE AskTheLab SHALL wrap it as `SELECT * FROM (<sql>) AS q LIMIT ASK_MAX_FETCH_ROWS` so that no model-written LIMIT can cause more than ASK_MAX_FETCH_ROWS rows to be materialized in the browser.
10. WHEN a result reaches ASK_MAX_FETCH_ROWS rows, THE AskTheLab SHALL indicate in the UI note and the CSV export that the result is capped at ASK_MAX_FETCH_ROWS.

### Requirement 6: Repair and Unavailable Fallback

**User Story:** As a data analyst, I want the app to recover from a bad query and to tell me clearly when AI is unavailable, so that a failure never breaks the app or leaves me stuck.

#### Acceptance Criteria

1. IF DuckDB returns an error while executing a GeneratedSql that passed the SqlValidator, THEN THE AskTheLab SHALL make at most one RepairCall that sends the DuckDB error message and the previous SQL back to the SqlProvider.
2. THE AskTheLab SHALL count a RepairCall against the same SqlProxy limits as the original request, and SHALL pass the repaired SQL through the SqlValidator before executing it.
3. IF the RepairCall's SQL also fails or is rejected, THEN THE AskTheLab SHALL display a friendly error message and SHALL NOT crash.
4. WHILE AiEnabled is off, THE AskTheLab SHALL not attempt the LLM path for free-form questions and SHALL show a clear message that AI is unavailable, directing the user to the StarterChips.
5. IF the SqlProxy returns 429 or 503, THEN THE AskTheLab SHALL show a clear "AI unavailable" message that directs the user to the StarterChips.
6. THE AskTheLab SHALL never crash the application on any question, SQL error, invalid model response, or proxy failure.

### Requirement 7: Result Value Conversion and CSV Export

**User Story:** As a data analyst, I want results that always render cleanly and a full CSV export, so that I can read and reuse every query result.

#### Acceptance Criteria

1. THE AskTheLab SHALL convert DuckDB result values to safe display values so that the table, chart, and CSV never show `[object Object]` and never throw.
2. WHEN a result value is a BigInt, THE AskTheLab SHALL convert it to a number when the value is within the safe-integer range and to a string otherwise.
3. WHEN a result value is a Date or timestamp, THE AskTheLab SHALL convert it to an ISO string.
4. WHEN a result value is a DECIMAL (for example from `ROUND(AVG(x), 2)`), THE AskTheLab SHALL convert it to a finite number, never to a typed-array JSON string or `[object Object]`.
5. THE AskTheLab SHALL provide a CSV export of the ENTIRE ResultTable (up to ASK_MAX_FETCH_ROWS rows), not only the first ASK_RESULT_DISPLAY_CAP rows.
6. THE AskTheLab SHALL quote CSV fields correctly, so that values containing commas, quotes, or newlines round-trip.

### Requirement 8: Hand-Built Lab-Themed Charts

**User Story:** As a participant, I want simple on-theme charts drawn without a heavy dependency, so that results are visual and the bundle stays lean.

#### Acceptance Criteria

1. THE AskTheLab SHALL render bar, line, and pie charts with small hand-built SVG components in the lab theme, and SHALL NOT add a new heavy charting dependency.
2. THE AskTheLab SHALL render a chart only for a ChartSpec whose type matches the data per Requirement 5.8.
3. WHEN a chart would show more than ASK_CHART_MAX_CATEGORIES categories, THE AskTheLab SHALL group the remaining categories as "Other" for a pie chart and truncate to ASK_CHART_MAX_CATEGORIES for a bar chart.
4. THE AskTheLab charts SHALL render body text with a contrast ratio of at least 4.5:1 against the themed background.

### Requirement 9: Configuration and Privacy

**User Story:** As a privacy-conscious user, I want only schemas and questions to leave the browser, and to be told exactly what the AI sees, so that my data stays private.

#### Acceptance Criteria

1. THE AskTheLab SHALL gate the LLM path on the existing `VITE_AI_ENABLED` flag and SHALL reuse the Feature 2 server-side environment variables.
2. THE AskTheLab SHALL send only the AskQuestion and the SchemaSummary to the SqlProxy, and SHALL NOT send full rows out of the browser.
3. THE AskTheLab SHALL display a short note in the UI stating that the AI sees column names and a few sample values only.
4. WHILE AiEnabled is off, THE AskTheLab SHALL make no network request for the LLM path.
5. THE AskTheLab SHALL render the explanation text, the GeneratedSql display, chart labels, and every result value as plain text, never as markup.

### Requirement 10: Tests

**User Story:** As a developer, I want focused tests (kept lean to save credits) covering the safety-critical and deterministic logic, so that the feature is trustworthy without burning the budget.

#### Acceptance Criteria

1. THE TestSuite SHALL include unit tests for the SqlValidator covering many cases: accepted SELECT/WITH queries, each forbidden keyword (bare vs. inside a literal or quoted identifier), chained statements, file/network table functions, `FROM 'path'`, a table-function in FROM, comma-separated unknown references, dotted non-`main` references, CTE-alias references, unknown-table references, and LIMIT enforcement.
2. THE TestSuite SHALL include unit tests for SchemaSummary budgeting, ChartSpec validation, result value conversion, CSV export, and StarterChip generation.
3. THE TestSuite SHALL include unit tests for the SqlProxy core handler using fake Redis and a fake upstream, covering the 400/403/405/413/429/503 paths and the shared daily-cap behavior.
4. THE TestSuite SHALL include a DuckDB-backed conversion test that selects DATE, TIMESTAMP, DECIMAL, HUGEINT or BIGINT, and BOOLEAN values and asserts the converted display values, in addition to the golden test.
5. THE TestSuite SHALL include at most THREE property-based tests: that the SqlValidator never accepts a statement containing a forbidden keyword outside string literals and quoted identifiers, or a second statement; that accepted SQL always carries a LIMIT; and that CSV export round-trips for generated rows.
6. THE TestSuite SHALL include one DuckDB golden test that, using a fake SqlProvider on the Feature 2 mismatched demo after stitching, confirms the question "how many monsters per species" produces the expected grouped counts and a bar ChartSpec.
7. THE TestSuite SHALL include adapter tests for `api/sql.ts` modeled on `api/ai.test.ts`, asserting the Node `(req, res)` adapter streams the body with its byte cap and writes the `{ status, body }` result without throwing.
8. WHEN `api/_shared.ts` is extracted from `api/ai.ts`, THE TestSuite's existing `api/ai.test.ts` and `src/core/stitching` proxy tests SHALL pass UNCHANGED and `npm run check:api` SHALL still pass, so the extraction does not change `/api/ai` behavior.
9. THE TestSuite SHALL extend `scripts/check-api.mjs` to smoke-test `api/sql` (type-check its Node ESM graph, import the emitted module, and invoke it as `(req, res)` expecting a fail-closed response with no network call).
10. THE TestSuite SHALL exercise the SqlProvider only through a fake implementation, with no real network calls.

### Requirement 11: Scope Boundaries

**User Story:** As a developer, I want the feature's scope bounded, so that it stays small and shippable for the hackathon.

#### Acceptance Criteria

1. THE AskTheLab SHALL NOT provide SQL editing in the UI.
2. THE AskTheLab SHALL NOT save or persist queries.
3. THE AskTheLab SHALL NOT maintain multi-turn chat memory across questions; each AskQuestion is answered independently (the RepairCall in Requirement 6 is a single follow-up for one failed query, not conversational memory).
4. THE AskTheLab SHALL NOT provide PDF export.
