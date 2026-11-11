# Implementation Plan: FrankenData "Ask the Lab" (Chat SQL)

## Overview

Feature 3 adds the "Ask the Lab" panel: once at least one table is loaded, the user asks a plain-English question about the loaded tables (including Feature 2's `stitch_<n>_result` tables) and gets a result table, an optional chart, and a CSV export. Everything runs in the browser except a single LLM call through a new `/api/sql` proxy that sends only the question plus a bounded schema summary — never full rows.

This plan is ordered so **value lands early and the feature works fully with AI off**: the deterministic SQL validator, starter chips, result conversion, CSV export, and the panel UI all ship before any network path. The LLM path (`/api/sql` proxy, `ProxySqlProvider`) is strictly additive — removing it leaves a working app driven by the starter chips. All core logic lives under `src/core/chat` (framework-agnostic) with React only at the edges under `src/components/chat`, per `.kiro/steering/structure.md`.

**Conventions (consistent with Features 1 and 2):**
- Property tests use `fast-check` with ≥100 iterations per property, in their own dedicated test files. There are exactly THREE (Requirement 10.5); each annotates its property and the requirement(s) it validates.
- The `SqlProvider` is exercised only through `FakeSqlProvider` — no real network in any test.
- Only genuine polish items are optional (`*`).
- Checkpoints run `npm test` (already `vitest --run`), `npm run lint`, `npm run build`, and (where the proxy graph changed) `npm run check:api`.

**Credit-saving rule:** execute in small batches and run the checkpoint after each group before moving on. Do not implement beyond what the requirements need; stop at a failing checkpoint and fix before continuing. Groups: (a) tasks 1–2, (b) tasks 3–4, (c) task 5, (d) task 6, (e) checkpoint task 7, (f) tasks 8–9, (g) task 10, (h) task 11, (i) checkpoint task 12, (j) optional task 13.

## Tasks

### Group A — safety core (validator)

- [x] 1. Chat types, constants, and the SqlValidator
  - Create `src/core/chat/types.ts`: `QueryableTable`, `SchemaColumn`/`SchemaTable`/`SchemaSummary`, `SqlRequest`, `SqlResponse`, `ChartType`/`ChartSpec`, `SqlProvider`, plus `AskOutcome`. Define the `ASK_*` constants (`ASK_MAX_QUESTION_CHARS = 300`, `ASK_RESULT_DISPLAY_CAP = 100`, `ASK_DEFAULT_SQL_LIMIT = 1000`, `ASK_MAX_FETCH_ROWS = 5000`, `ASK_HISTORY_SIZE = 5`, `ASK_MAX_STARTER_CHIPS_PER_TABLE = 4`, `ASK_CATEGORY_DISTINCT_MAX = 12`, `ASK_CHART_MAX_CATEGORIES = 20`, `ASK_SCHEMA_MAX_TABLES = 10`, `ASK_SCHEMA_MAX_COLUMNS_PER_TABLE = 40`, `ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN = 3`, `ASK_SCHEMA_MAX_SAMPLE_CHARS = 30`, `ASK_SCHEMA_MAX_PAYLOAD_BYTES = 16384`); re-export the reused Feature 2 `AI_PROXY_*` / `AI_REQUEST_TIMEOUT_MS`
  - Implement `src/core/chat/sql-validator.ts`: the single-pass tokenizer that strips comments and separates string literals, dollar-quoted strings, and double-quoted identifiers into distinct token kinds; then the whole-word checks: single read-only statement (first keyword `SELECT`/`WITH`, no non-trailing `;`), forbidden-keyword rejection (outside literals/identifiers), blocked file/network table functions, FROM/JOIN table-position rules (reject string/quoted-path positions; reject table-function calls not on the empty-by-default allowlist; check EVERY comma-separated reference; reject dotted refs unless qualifier is exactly `main`), CTE-alias collection, QueryableTable allowlisting, and `ASK_DEFAULT_SQL_LIMIT` enforcement when no LIMIT is present
  - _Design: SqlValidator algorithm; Requirements 5.1–5.7_

- [x] 2. SqlValidator unit tests + property tests 1 & 2
  - Unit tests covering many cases: accepted `SELECT`/`WITH`; each forbidden keyword bare (reject) vs. inside a literal/quoted identifier (accept, e.g. `WHERE status = 'Load'`, column `"set"`); chained statements; `read_csv`/`read_parquet`/`read_json`/`glob`/httpfs functions; `FROM 'data.csv'`; a table-function in FROM; `FROM a, 'file.csv'` and `FROM a, unknown`; `information_schema.tables` and other dotted non-`main` refs; `main.t` accepted; CTE alias allowed; unknown table rejected; LIMIT present-vs-enforced
  - Property test 1 (own file): for arbitrary SQL embedding a forbidden keyword as a whole word OUTSIDE literals/quoted identifiers, or a second `;`-separated statement, `validate` returns `ok: false`
  - Property test 2 (own file): any SQL `validate` accepts carries a `LIMIT` in the returned SQL
  - _Design: Correctness properties 1 & 2; Requirements 5.2–5.7, 10.1, 10.5_

### Group B — result conversion, CSV, chips, schema

- [x] 3. Result conversion and CSV export (+ property test 3)
  - Implement `src/core/chat/result-convert.ts` `toDisplayValue`: null/undefined→`""`; bigint→number when safe else string; Date→ISO and known timestamp epoch-ms→ISO; **DECIMAL (scaled/Arrow decimal)→finite number**; number/boolean/string as-is; other typed arrays/objects→JSON string (never `[object Object]`, never throws)
  - Implement `src/core/chat/csv-export.ts` `toCsv(columns, rows)`: full result with RFC-4180 quoting (quote on `,` `"` `\n` `\r`; double inner quotes; `\r\n` row sep)
  - Unit tests for both; property test 3 (own file): for arbitrary rows (commas/quotes/newlines/numbers/nulls), parsing `toCsv` output with a reference parser yields the converted values
  - _Design: Result value conversion, CSV export, Correctness property 3; Requirements 7.1–7.6, 10.2, 10.5_

- [x] 4. Starter questions and schema builder
  - Implement `src/core/chat/starter-questions.ts`: deterministic chips per `QueryableTable` (row count; rows-per-category for the first string column with ≤`ASK_CATEGORY_DISTINCT_MAX` distinct values, carrying a bar `ChartSpec`; top-10 by first numeric column; min/max/avg of first numeric column), capped at `ASK_MAX_STARTER_CHIPS_PER_TABLE`, columns walked in schema order, identifiers escaped via `sql-escape.ts`, distinct counts via a cached `DuckDBService.query` probe
  - Implement `src/core/chat/schema-builder.ts`: build `SchemaSummary` (reusing the Feature 2 `SampleReader` for bounded distinct samples), order tables `stitch_<n>_result` → originals → `stitch_<n>_clean_*`, cap tables/columns/samples/sample-chars, then drop from the END until under `ASK_SCHEMA_MAX_PAYLOAD_BYTES`
  - Unit tests: chip determinism + applicable-pattern-only generation; schema ordering, caps, and byte-budget trimming
  - _Design: StarterChips, SchemaSummary budgeting; Requirements 2.1–2.4, 2.6, 3.3, 3.4_

### Group C — controller (works with AI off)

- [x] 5. AskController with FakeSqlProvider and the executor row cap
  - Implement `src/core/chat/sql-provider.ts` `FakeSqlProvider` (canned response / fn / throw; records calls) — `ProxySqlProvider` comes in Group F
  - Implement `src/core/chat/ask-controller.ts`: non-throwing `ask` returning `AskOutcome` (`ok` / `ai-unavailable` / `error`). Chip path: validate → execute → convert. Free-form with AI off: `ai-unavailable` (no network). Free-form with AI on: schema → provider → validate → execute, with ONE RepairCall on a DuckDB error (re-validated, counts against limits), and `ai-unavailable` on a 429/503-like provider failure. Executor wraps accepted SQL as `SELECT * FROM (<sql>) AS q LIMIT ASK_MAX_FETCH_ROWS` and flags the capped case
  - Unit tests with `FakeSqlProvider` + an injected query runner: chip path, AI-off, repair-once success, repair-still-fails→error, 429/503→ai-unavailable, never throws, fetch-cap wrap applied
  - _Design: AskController flow, Executor hard row cap; Requirements 2.5, 5.8 (drop invalid chart hook), 6.1–6.6, 9.4, 5.9, 5.10_

### Group D — UI wired into App (AI-off usable)

- [x] 6. Ask the Lab panel, chips, result table, SqlBlock, wired into App
  - Implement `src/state/ask-store.ts` (session-only: last `ASK_HISTORY_SIZE` questions, current outcome)
  - Implement `src/components/chat/`: `AskTheLabPanel` (+`.css`) gated on ≥1 queryable table, with input (≤`ASK_MAX_QUESTION_CHARS`), submit, loading state, history list, privacy note ("AI sees column names and a few sample values only"), and the "AI unavailable → use the chips" message; `StarterChips`; `SqlBlock` (code block + copy, explanation, all plain text); `ResultTableView` (+`.css`) capped at `ASK_RESULT_DISPLAY_CAP` with a "showing N of M" / capped-at-`ASK_MAX_FETCH_ROWS` note and a full-CSV download; apply the lab theme tokens (≥4.5:1)
  - Wire the panel into `src/App.tsx` below the stitching UI; render every value/label as plain text
  - Smoke test(s): panel hidden with no tables; a clicked chip renders a result table with AI off
  - _Design: Module layout (components), AskController flow; Requirements 1.1–1.8, 2.1, 7.5, 9.1–9.5, 11.1–11.4_

- [x] 7. **Checkpoint** — AI-off feature complete
  - Run `npm test`, `npm run lint`, `npm run build`; fix any failures before continuing
  - Confirm the app runs with AI off end to end: load demo data, click a starter chip, see the result table and CSV download
  - _Design: Overview; Requirements 2.5, 9.4_

### Group E — LLM path (additive)

- [x] 8. `/api/sql` proxy core handler + `api/_shared.ts` extraction
  - Extract the Node adapter helpers (`readBodyCapped`, `makeUpstashRedis`, `makeLlmClient`, `header`, `clientIpFrom`) from `api/ai.ts` into `api/_shared.ts` (plain Node ESM, explicit `.js` import extensions) and have `api/ai.ts` import them — a PURE refactor: `api/ai.ts` keeps the same default-export behavior so `api/ai.test.ts` and the `src/core/stitching` proxy tests pass UNCHANGED and `npm run check:api` still passes
  - Implement `src/core/chat/sql-proxy.ts` `handleSqlProxyRequest`, reusing `ai-proxy.ts` primitives (`utf8ByteLength`, `RedisClient`/`LlmClient`/`AiProxyEnv`/`AiProxyHttpRequest`, origin check, bucket helpers, `parseLlmResponse`, SHA-256) with the SAME ordered checks and status codes, a strict `SqlRequest` schema (question ≤300, bounded schema, optional `repair`), its OWN per-client key prefix (`rlsql:`), and the SHARED `cap:<day>` daily-cap key; build the temperature-0, JSON-only, untrusted-data prompt; add a `buildSqlUserPrompt`
  - Unit tests with fake Redis + fake upstream: 400/403/405/413/429/503, the shared daily-cap increment, fail-closed on missing env / unreachable counter / upstream error
  - _Design: Proxy code sharing, SqlProxy prompt; Requirements 4.1–4.8, 3.7, 3.8, 10.3, 10.8_

- [x] 9. `api/sql.ts` adapter, ProxySqlProvider, and check-api extension
  - Implement `api/sql.ts`: thin Node `(req, res)` entrypoint mirroring `api/ai.ts`, importing the shared helpers from `api/_shared.ts`, reading the same `process.env`, delegating to `handleSqlProxyRequest`
  - Implement `ProxySqlProvider` in `src/core/chat/sql-provider.ts`: POST `/api/sql`, abort after `AI_REQUEST_TIMEOUT_MS`, treat any non-200/timeout/network/non-JSON as failure; send only `{ question, schema, repair? }`; wire it into the panel when `VITE_AI_ENABLED === "true"`
  - Add `api/sql.ts` (+ `api/_shared.ts` + `src/core/chat/sql-proxy.ts` + `src/core/chat/types.ts`) to `tsconfig.api.json` `include`; extend `scripts/check-api.mjs` to type-check, import, and `(req, res)`-invoke the emitted `api/sql.js` expecting a fail-closed 400/503 with no network
  - Adapter tests in `api/sql.test.ts` modeled on `api/ai.test.ts` (valid POST→503 unconfigured; `{}`→400 with env set; oversized→413; GET→405)
  - _Note: after deploy, manually re-verify the existing `/api/ai` with a curl and run a live stitch to confirm the `api/_shared.ts` extraction did not regress Feature 2._
  - _Design: Proxy code sharing; Requirements 4.1–4.6, 3.6, 9.1, 9.2, 10.6, 10.7, 10.8_

### Group F — charts and golden

- [x] 10. ChartSpec validation and BarChart
  - Implement `src/core/chat/chart-spec.ts`: validate a `ChartSpec` against result columns (type allowed, x and y exist, y numeric), drop when invalid; category capping (`ASK_CHART_MAX_CATEGORIES`: truncate for bar, group "Other" for pie). Wire chart validation into `AskController`/panel so an invalid chart is dropped and the table still shows
  - Implement `src/components/chat/charts/BarChart.tsx` (+`charts/chart.css`): hand-built SVG, lab theme, plain-text labels, ≥4.5:1; render it in the panel when a valid bar `ChartSpec` is present
  - Unit tests for `chart-spec` (valid/invalid, capping/Other)
  - _Design: ChartSpec validation, Charts; Requirements 5.8, 8.1–8.4_

- [x] 11. DuckDB golden test + real-DuckDB conversion test
  - Golden test (node-blocking-bundle harness like `stitch-golden.duckdb.test.ts`): load the Feature 2 mismatched demo, stitch it, run `AskController.ask("how many monsters per species")` with a `FakeSqlProvider` returning the grouped-count SQL + bar `ChartSpec`; assert the grouped counts match the known demo data and the validated `ChartSpec` is the bar spec
  - Real-DuckDB conversion test: select DATE, TIMESTAMP, DECIMAL (`ROUND(AVG(x),2)`), HUGEINT or BIGINT, and BOOLEAN values, pass real result rows through `toDisplayValue`, and assert the display values (ISO strings, finite decimal number, safe/string big integer, boolean) — never a typed-array JSON string or `[object Object]`
  - _Design: Golden test, Real-DuckDB conversion test; Requirements 7.1–7.4, 10.4, 10.6_

- [x] 12. **Checkpoint** — full feature
  - Run `npm test`, `npm run lint`, `npm run build`, `npm run check:api`; fix any failures
  - With `VITE_AI_ENABLED` on (fake/local), confirm a free-form question path works; with it off, confirm chips still work
  - _Design: Overview; Requirements 4, 6, 9_

### Group G — optional polish

- [ ] 13.* LineChart and PieChart
  - Implement `src/components/chat/charts/LineChart.tsx` and `PieChart.tsx` (hand-built SVG, lab theme, plain-text labels, ≥4.5:1), rendered when the validated `ChartSpec` type is `line`/`pie`; pie groups beyond `ASK_CHART_MAX_CATEGORIES` as "Other"
  - Unit/smoke tests for rendering
  - _Design: Charts; Requirements 8.1, 8.3, 8.4_
