# Design Document — FrankenData "Ask the Lab" (Chat SQL)

## Overview

This document describes the architecture for **Feature 3: Ask the Lab** of FrankenData. Feature 1 (file intake) loads messy CSV/XLSX files into typed, in-memory DuckDB-WASM tables; Feature 2 (AI stitching) joins them into `stitch_<n>_result` tables. This feature lets the user ask a plain-English question about the loaded tables and get a result table, an optional chart, and a CSV export.

Everything runs in the browser except a single LLM call through a new `/api/sql` proxy. DuckDB executes every query locally. The only data that leaves the browser is the question plus a bounded `SchemaSummary` (table/column names, types, a few short sample values) — never full rows. The feature is useful with AI off: deterministic rule-built StarterChips run directly against DuckDB.

A client-side `SqlValidator` gates every generated query (LLM, repair, or chip) before it reaches DuckDB. Results are converted to safe display values and can be exported in full as CSV. Charts are small hand-built SVG components in the lab theme.

Out of scope: SQL editing, saved queries, multi-turn memory, PDF export.

## Architecture

Following `.kiro/steering/structure.md`: pure, framework-agnostic logic lives under `src/core/chat`; React sits only at the edges under `src/components/chat`. The LLM path is reached through an injected `SqlProvider` seam (production = `/api/sql`, tests = fake), exactly mirroring Feature 2's `AiProvider`. The proxy's decision logic is a framework-agnostic core handler; `api/sql.ts` is a thin Node `(req, res)` adapter.

```
AskQuestion (free-form)            StarterChip click (rule SQL)
      │  AiEnabled                        │
      ▼                                   │
SchemaBuilder → SchemaSummary             │
      │                                   │
      ▼                                   │
SqlProvider.ask(question, schema)         │
   → { sql, explanation, chart? }         │
      │                                   │
      └───────────────┬───────────────────┘
                      ▼
             SqlValidator.validate(sql, queryableTables)
                      │  accept (+ LIMIT) / reject
                      ▼
             DuckDBService.query(sql)
                      │  error → ONE RepairCall (LLM only) → re-validate → retry
                      ▼
             ResultConverter → ResultTable (safe values)
                      │
          ┌───────────┴────────────┐
          ▼                         ▼
   TableView (cap 100)       ChartSpec validate → ChartView (SVG)   CsvExport (full)
```

### Module layout

**`src/core/chat/` (pure, framework-agnostic):**

- `types.ts` — shared types and the named constants (`ASK_*`, including `ASK_MAX_FETCH_ROWS`); re-uses Feature 2's `AI_PROXY_*` / `AI_REQUEST_TIMEOUT_MS` from `src/core/stitching/types.ts`. Declares `SchemaSummary`, `SqlRequest`, `SqlResponse`, `ChartSpec`, `SqlProvider`, `QueryableTable`.
- `sql-validator.ts` — the tokenizer + validator (Requirement 5). The safety heart; unit- and property-tested.
- `schema-builder.ts` — builds and budget-trims a `SchemaSummary` from the queryable tables and their sampled values (Requirement 3.3–3.4).
- `starter-questions.ts` — deterministic StarterChip generation and rule SQL builders (Requirement 2).
- `sql-provider.ts` — `ProxySqlProvider` (POSTs `/api/sql`) and `FakeSqlProvider` (tests), behind the `SqlProvider` interface. Mirrors `stitching/ai-provider.ts`.
- `result-convert.ts` — DuckDB value → safe display value (Requirement 7.1–7.3).
- `csv-export.ts` — full-result CSV with RFC-4180 quoting (Requirement 7.4–7.5).
- `chart-spec.ts` — `ChartSpec` validation against result columns + category capping/Other-grouping (Requirements 5.8, 8.3).
- `ask-controller.ts` — orchestrates one question: build schema → provider → validate → query → repair-once → convert; returns an `AskOutcome` discriminated union (`ok` / `ai-unavailable` / `error`). Never throws.
- `sql-proxy.ts` — the framework-agnostic `/api/sql` handler (reuses `ai-proxy.ts` primitives; see "Proxy code sharing").

**`src/components/chat/` (React, edges only):**

- `AskTheLabPanel.tsx` + `.css` — the themed panel: input, submit, loading, history, privacy note, "AI unavailable" message, StarterChip row. Gated on ≥1 queryable table.
- `StarterChips.tsx` — renders the deterministic chips; clicking runs its SQL via the controller (no LLM).
- `SqlBlock.tsx` — the GeneratedSql code block + copy button + one-sentence explanation (rendered as plain text).
- `ResultTableView.tsx` + `.css` — result grid, capped at `ASK_RESULT_DISPLAY_CAP` with a "showing N of M" note.
- `charts/BarChart.tsx`, `charts/LineChart.tsx`, `charts/PieChart.tsx` + `charts/chart.css` — hand-built SVG, lab theme.
- `ask-store.ts` (in `src/state/`) — session-only history (last `ASK_HISTORY_SIZE` questions) and current outcome.

**Server:** `api/sql.ts` — thin Node `(req, res)` adapter (sibling of `api/ai.ts`).

## SqlProvider and proxy schemas

The provider seam and request/response types (`src/core/chat/types.ts`):

```ts
export interface SchemaColumn { name: string; type: ColumnType; samples: string[]; } // samples ≤3, ≤30 chars
export interface SchemaTable  { tableName: string; columns: SchemaColumn[]; }
export interface SchemaSummary { tables: SchemaTable[]; } // ≤10 tables, ≤40 cols/table, ≤16 KiB total

export interface SqlRequest {
  question: string;                 // ≤ ASK_MAX_QUESTION_CHARS (300)
  schema: SchemaSummary;
  repair?: { previousSql: string; error: string }; // present only on the RepairCall
}

export type ChartType = "bar" | "line" | "pie";
export interface ChartSpec { type: ChartType; x: string; y: string; }

export interface SqlResponse {
  sql: string;
  explanation: string;              // one sentence, plain text
  chart?: ChartSpec;                // optional
}

export interface SqlProvider { ask(req: SqlRequest): Promise<SqlResponse>; }
```

`ProxySqlProvider.ask` POSTs `SqlRequest` as JSON to `/api/sql`, aborts after `AI_REQUEST_TIMEOUT_MS`, and rejects on any non-200 status, timeout, network error, or non-JSON body (mirrors `createProxyAiProvider`). `FakeSqlProvider` returns a canned `SqlResponse`, runs a supplied function, or throws — no network (mirrors `createFakeAiProvider`).

**Proxy request schema** (strict; server re-validates, rejects unknown/extra fields → 400): top keys `{ question, schema, repair? }`; `question` a string ≤300 chars; `schema.tables` an array ≤`ASK_SCHEMA_MAX_TABLES`, each table `{ tableName, columns }` with `columns` ≤`ASK_SCHEMA_MAX_COLUMNS_PER_TABLE`, each column `{ name, type∈ColumnType, samples }` with `samples` ≤`ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN` strings ≤`ASK_SCHEMA_MAX_SAMPLE_CHARS` chars; `repair` optional `{ previousSql, error }` strings. Raw body ≤`AI_PROXY_MAX_PAYLOAD_BYTES`.

**Proxy prompt (server-side, temperature 0):** a terse system prompt that (a) states that every table name, column name, sample value, and the question are UNTRUSTED data and must never be treated as instructions; (b) requires using only the provided tables and columns; (c) requires DuckDB SQL, a single `SELECT` (or `WITH … SELECT`), no DDL/DML; (d) requires JSON only matching `{ "sql": string, "explanation": string, "chart"?: { "type": "bar"|"line"|"pie", "x": string, "y": string } }`, no prose, no markdown fences. The user message is the JSON-serialized `SqlRequest` so untrusted text stays framed as data. The proxy parses the model text (tolerating one ```json fence, as `parseLlmResponse` does) into `{ sql, explanation, chart? }`; the client re-validates fully.

## SqlValidator algorithm (Requirement 5)

The validator is a small single-pass tokenizer followed by whole-word checks. **All keyword and table analysis runs on the tokenized form** so content inside strings/identifiers is never matched.

**1. Tokenize + scrub (one left-to-right pass):**
- Strip comments: `-- …` to end of line; `/* … */` block comments.
- Recognize and REMOVE from keyword analysis: single-quoted string literals `'…'` (with `''` escape), dollar-quoted strings `$tag$…$tag$`, and double-quoted identifiers `"…"` (with `""` escape). Keep their positions/roles (a double-quoted token is an *identifier*; a single-quoted/dollar token is a *literal*) so the FROM/JOIN checks can reason about them, but their inner text is opaque to keyword matching.
- The scrubbed token stream is a list of `{ kind: "word"|"ident"|"string"|"punct", text }`.

**2. Single read-only statement:**
- Reject if any `;` punct appears other than a single trailing one (ignoring trailing whitespace/comments) → no chained second statement.
- The first significant `word` token (uppercased) must be `SELECT` or `WITH`; otherwise reject.

**3. Forbidden keywords (whole word, outside literals/identifiers):**
- Reject if any `word` token (not `ident`, not `string`) uppercased is in `{INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH, DETACH, COPY, PRAGMA, INSTALL, LOAD, CALL, EXPORT, SET}`. Because literals and quoted identifiers are separate token kinds, `WHERE status = 'Load'` and a column `"set"` pass.

**4. File/network table functions (whole word):**
- Reject if any `word` token that is immediately followed by a `(` punct is in the blocked function set `{read_csv, read_csv_auto, read_parquet, read_json, read_json_auto, read_text, glob, parquet_scan, csv_scan, iceberg_scan, delta_scan, read_blob, …}` or matches an `httpfs`/URL-scheme pattern. Case-insensitive.

**5. Table positions (FROM / JOIN):**
- Walk the token stream; after a `FROM` or `JOIN` word, inspect the table reference. A `FROM` clause may list **several comma-separated references** (`FROM a, b`); EVERY comma-separated reference in that clause is checked exactly like the first (so `FROM a, 'file.csv'` and `FROM a, unknown` are both rejected). Comma-splitting stops at the first clause-ending keyword (`WHERE`, `GROUP`, `ORDER`, `HAVING`, `LIMIT`, `JOIN`, `ON`, `UNION`, …) or the statement end.
- For each reference:
  - A `string` token (single-quoted/dollar) in a table position → reject (`FROM 'data.csv'`, `FROM 'https://…'`).
  - A `word` token immediately followed by `(` (a table-*function* call) → reject unless the function name is on an explicit `allowedTableFunctions` allowlist (default empty).
  - A replacement-scan-style bare reference that is not a known table (e.g. a quoted path, a name ending in `.csv`/`.parquet`/`.json`, or a URL) → reject.
  - A **dotted reference** `qualifier.name` → reject unless the qualifier is exactly `main` (so `information_schema.tables`, `pg_catalog.*`, and any other schema are rejected); when the qualifier is `main`, the referenced table is `name`.
  - Otherwise collect the referenced table name (an `ident` yields its literal inner text; a `word` yields its text) as a **referenced table**.

**6. Table allowlisting:**
- Collect **CTE aliases**: names defined by `WITH alias AS (…)` (and comma-separated further CTEs) in the statement. These are allowed as references.
- Every referenced table that is not a CTE alias must be a current `QueryableTable` (matched by the sanitized DuckDB table name). Otherwise reject.

**7. LIMIT enforcement (Requirement 5.7):**
- If no top-level `LIMIT` word token is present, append ` LIMIT <ASK_DEFAULT_SQL_LIMIT>` to the (comment-stripped, trailing-`;`-trimmed) SQL. If a `LIMIT` is present, leave it unchanged.

Result: `{ ok: true; sql } | { ok: false; reason }`. The accepted `sql` (comment-stripped, limit-enforced) is what reaches the executor.

### Executor hard row cap (`ASK_MAX_FETCH_ROWS = 5000`)

The `SqlValidator`'s `LIMIT` enforcement only covers queries with *no* LIMIT; a model is free to write `LIMIT 9999999`. To ensure a huge model-written LIMIT can never flood the browser, the executor always wraps the accepted SQL before handing it to `DuckDBService.query`:

```
SELECT * FROM (<accepted sql>) AS q LIMIT <ASK_MAX_FETCH_ROWS>
```

When the fetched row count equals `ASK_MAX_FETCH_ROWS`, the result is treated as capped: the UI "showing N of M" note and the CSV export both state the result is capped at `ASK_MAX_FETCH_ROWS`. (The display cap `ASK_RESULT_DISPLAY_CAP = 100` still applies to the on-screen table; the fetch cap bounds what is ever materialized.)

### ChartSpec validation (`chart-spec.ts`, Requirement 5.8)

Given a `ChartSpec` and the `ResultTable` columns: accept only if `type ∈ {bar,line,pie}`, both `x` and `y` are result column names, and the `y` column is numeric (sampled values coerce to finite numbers). On any failure return "no chart" — the controller shows the table without a chart. Charts never throw.

## Result value conversion (`result-convert.ts`, Requirement 7)

`toDisplayValue(v)` applies, in order:
- `null`/`undefined` → `""`.
- `bigint` → `Number(v)` when `v` is within `Number.MIN_SAFE_INTEGER..MAX_SAFE_INTEGER`, else `String(v)`.
- `Date` → `v.toISOString()`. A DuckDB timestamp that arrives as epoch-ms number in a known timestamp column → ISO via `new Date(ms).toISOString()`; a DuckDB `DATE` already normalized upstream stays a string.
- **DECIMAL** — DuckDB-WASM returns `DECIMAL` values (e.g. from `ROUND(AVG(x), 2)`) as a scaled representation, not a plain JS number. The converter detects this (a value carrying `scale`/`value` fields, or a typed-array/Arrow decimal) and converts it to a **finite JS number** (scaled value ÷ 10^scale), falling back to `Number(String(v))` — never a typed-array JSON string and never `[object Object]`.
- `number`/`boolean`/`string` → as-is (string unchanged).
- Other typed arrays / objects (structs, lists) → JSON string (never `[object Object]`).

The converter is used uniformly by the table, chart, and CSV so all three agree and none throw. All displayed values are rendered as plain text (Requirement 9.5).

## CSV export (`csv-export.ts`, Requirement 7)

`toCsv(columns, rows)` emits the header then every converted row (the FULL result, not the display cap). A field is quoted when it contains `,`, `"`, `\n`, or `\r`; inner `"` is doubled; rows joined with `\r\n`. Round-trips with a reference parser (property test 3).

## Charts (`src/components/chat/charts/`, Requirement 8)

Three small presentational SVG components, no new dependency, colored from `src/theme/tokens.ts` (`labGreen`, `labPurple`, `amberAccent`, text `textPrimary`/`textSecondary` ≥4.5:1):
- `BarChart` — vertical bars; x = category column, y = numeric column; truncates to `ASK_CHART_MAX_CATEGORIES` bars.
- `LineChart` — polyline over ordered x; y numeric.
- `PieChart` — slices from y per x; categories beyond `ASK_CHART_MAX_CATEGORIES` summed into one "Other" slice.
All labels are plain text.

## StarterChips (`starter-questions.ts`, Requirement 2)

For each `QueryableTable`, deterministically emit up to `ASK_MAX_STARTER_CHIPS_PER_TABLE` chips, in a fixed order, only for applicable columns:
- **Row count** (always): `SELECT COUNT(*) AS row_count FROM <t>` — "How many rows are in <t>?"
- **Rows per category** — first string column with ≤`ASK_CATEGORY_DISTINCT_MAX` distinct values: `SELECT <c> AS category, COUNT(*) AS count FROM <t> GROUP BY <c> ORDER BY count DESC` — carries a bar `ChartSpec {x: category, y: count}`.
- **Top 10 by numeric** — first numeric column: `SELECT * FROM <t> ORDER BY <c> DESC LIMIT 10`.
- **Min/max/avg of numeric** — first numeric column: `SELECT MIN(<c>) AS min, MAX(<c>) AS max, AVG(<c>) AS avg FROM <t>`.

Distinct counts come from a cached per-column probe via `DuckDBService.query`. Identifiers escaped with the existing `sql-escape.ts`. Determinism: columns walked in schema order; same schema → same chips. Every chip's SQL still passes through `SqlValidator` before running (Requirement 2.6).

## SchemaSummary budgeting (`schema-builder.ts`, Requirement 3)

Build a `SchemaSummary` from the queryable tables and their sampled values (reuse the Feature 2 `SampleReader` for bounded, distinct samples), then trim to fit:
- Order tables: `stitch_<n>_result` first, then original `LoadedTable`s, then `stitch_<n>_clean_*` (Requirement 3.4).
- Cap to `ASK_SCHEMA_MAX_TABLES` tables, `ASK_SCHEMA_MAX_COLUMNS_PER_TABLE` columns/table, `ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN` samples/column (each truncated to `ASK_SCHEMA_MAX_SAMPLE_CHARS`).
- Measure the JSON byte length; while over `ASK_SCHEMA_MAX_PAYLOAD_BYTES`, drop from the END of the ordered list (whole tables last, then samples) until it fits. Never emits full rows.

## AskController flow (`ask-controller.ts`, Requirements 1, 6)

`ask(question | chipSql)` returns a non-throwing `AskOutcome`:
1. **Chip path:** validate the chip SQL → query → convert → `ok` (with the chip's `ChartSpec` if valid). No LLM.
2. **Free-form, AiEnabled off:** return `ai-unavailable` (UI points to chips). No network (Requirement 9.4).
3. **Free-form, AiEnabled on:** build `SchemaSummary` → `SqlProvider.ask` → validate SQL → query.
   - DuckDB error on valid SQL → ONE `RepairCall` with `{ previousSql, error }` → re-validate → retry. Counts against proxy limits (Requirement 6.2).
   - Provider rejects with a 429/503-like failure → `ai-unavailable`.
   - Still failing, invalid response, or validator reject → `error` (friendly message).
4. Validate the model's `ChartSpec` against the result columns; drop if invalid.

The outcome's SQL, explanation, chart labels, and values are rendered as plain text by the components (Requirement 9.5).

## Proxy: `api/sql.ts` and code sharing (Requirements 4, 9)

`api/sql.ts` is a near-copy of `api/ai.ts`'s adapter: the SAME `readBodyCapped` byte-cap streaming, the SAME `makeUpstashRedis` and `makeLlmClient`, the SAME `process.env` reads (`AI_PROVIDER`, `AI_MODEL`, `OPENAI_API_KEY`/`AI_API_KEY`, `UPSTASH_REDIS_REST_URL`/`_TOKEN`, `IP_HASH_SALT`, `ALLOWED_ORIGINS`, `AI_BASE_URL`). To avoid duplicating the adapter logic, the shared Node-adapter helpers (`readBodyCapped`, `makeUpstashRedis`, `makeLlmClient`, `header`, `clientIpFrom`) are extracted into `api/_shared.ts` (plain Node ESM with explicit `.js` import extensions, so `check:api` passes) and imported by both `api/ai.ts` and `api/sql.ts`. Each entrypoint only builds its env/clients and delegates to its own core handler.

The core handler `handleSqlProxyRequest` in `src/core/chat/sql-proxy.ts` reuses `ai-proxy.ts` primitives directly — `utf8ByteLength`, the `RedisClient`/`LlmClient`/`AiProxyEnv`/`AiProxyHttpRequest` types, `originAllowed`, the bucket helpers, `parseLlmResponse`, and the SHA-256 default — and applies the SAME ordered checks as `handleAiProxyRequest`: method (405) → required env (503) → payload size (413) → strict schema (400) → origin (403) → per-client hourly counter (429) → global daily cap (429+cap) → upstream (503 on any error). Two deliberate differences:

- **Per-client key prefix:** `handleSqlProxyRequest` uses `rlsql:<clientId>:<hour>` so the SQL proxy has its OWN hourly bucket, independent of `/api/ai`'s `rl:…` (Requirement 4.6).
- **Shared daily cap key:** it increments the EXACT SAME `cap:<day>` key that `handleAiProxyRequest` uses, so the `AI_PROXY_DAILY_REQUEST_CAP` is counted across BOTH proxies (Requirement 4.6). This is the single global spending cap.

Everything else (fail-closed on missing env / unreachable Redis / upstream error, never calling the LLM without a counter, never logging samples or the question) is inherited from the shared structure (Requirements 4.7, 4.8).

**Regression-safety constraint for the `api/_shared.ts` extraction:** extracting the adapter helpers out of `api/ai.ts` into `api/_shared.ts` MUST NOT change `/api/ai` behavior. `api/ai.ts` must keep the SAME default-export `(req, res)` handler and identical observable behavior, so the existing `api/ai.test.ts` and the `src/core/stitching` proxy tests pass UNCHANGED, and `npm run check:api` still passes (with `tsconfig.api.json`'s `include` extended to the new files). The extraction is a pure refactor verified by the unchanged Feature 2 tests before any `/api/sql` logic is added.

## Correctness properties (the 3 property tests, Requirement 10.4)

1. **Validator rejects forbidden keywords / second statements.** For arbitrary generated SQL that embeds any forbidden keyword as a whole word *outside* string literals and quoted identifiers, OR embeds a second `;`-separated statement, `SqlValidator.validate` returns `ok: false`. (Generators place keywords both bare and inside `'…'`/`"…"`; the bare cases must reject and are the ones the property asserts.)
2. **Accepted SQL always carries a LIMIT.** For any SQL the validator accepts, the returned `sql` contains a `LIMIT` (either the original or the appended `ASK_DEFAULT_SQL_LIMIT`).
3. **CSV round-trips.** For arbitrary generated rows (strings with commas, quotes, newlines; numbers; nulls), parsing `toCsv(cols, rows)` back with a reference CSV parser yields the converted values.

## Real-DuckDB conversion test (Requirement 7)

In addition to the pure `result-convert` unit tests and the one golden test, a DuckDB-backed test (same node-blocking-bundle harness as the golden test) runs a query selecting a `DATE`, a `TIMESTAMP`, a `DECIMAL` (e.g. `ROUND(AVG(x), 2)`), a `HUGEINT` or `BIGINT`, and a `BOOLEAN` value, passes the real DuckDB result rows through `toDisplayValue`, and asserts the converted display values: date/timestamp are ISO strings, the decimal is a finite number, the big integer is a number (safe) or string (out of range), and the boolean is a boolean — never a typed-array JSON string and never `[object Object]`.

## Golden test (Requirement 10.5)

A DuckDB golden test (same node-blocking-bundle harness as `stitch-golden.duckdb.test.ts`) loads the Feature 2 mismatched demo, stitches it, then runs `AskController.ask("how many monsters per species")` with a `FakeSqlProvider` returning `SELECT species, COUNT(*) AS count FROM <stitched> GROUP BY species ORDER BY count DESC` and a bar `ChartSpec {x: species, y: count}`. Asserts the grouped counts match the known demo data and the validated `ChartSpec` is the bar spec.

## Testing strategy

Lean, per Requirement 10: unit tests for the validator (many cases: accepted SELECT/WITH, each forbidden keyword bare vs. in-literal, chained statements, file/network functions, `FROM 'path'`, table-function in FROM, unknown table, CTE alias allowed, LIMIT enforcement), schema budgeting + ordering, ChartSpec validation, result conversion, CSV export, StarterChip generation; proxy-handler tests with fake Redis + fake upstream for 400/403/405/413/429/503 and the shared daily-cap increment; `api/sql.ts` `(req, res)` adapter tests modeled on `api/ai.test.ts`; exactly the 3 property tests above; the one golden test; and a `scripts/check-api.mjs` extension that type-checks, imports, and `(req, res)`-invokes the emitted `api/sql.js` expecting a fail-closed 400/503 with no network. The `SqlProvider` is exercised only through `FakeSqlProvider`.
