---
inclusion: always
---

# Security and privacy rules

These are the non-negotiable safety invariants of FrankenData. Preserve them in every change.

## Data stays in the browser

- All user data (dropped files, parsed rows, DuckDB tables) stays client-side. There is no upload of rows and no persistence: refreshing the page discards everything.
- The only network calls are the optional `/api/ai` and `/api/sql` proxies, and they run only when `VITE_AI_ENABLED` is exactly "true".
- Only column names, column types, and a few short sample values per column ever leave the browser, and only when AI is enabled. Never send full rows.

## Secrets

- The only client-visible variable is `VITE_AI_ENABLED` (the `VITE_` prefix exposes it to the bundle). Every other variable is server-side only.
- No secret value belongs in the repo or the client bundle. The LLM API key is read from `process.env` only inside the serverless functions and is never returned to the client or logged.
- `.env` is gitignored. `.env.example` ships placeholders only.

## Proxies fail closed

- Both proxies (`src/core/stitching/ai-proxy.ts` and `src/core/chat/sql-proxy.ts`) fail closed: missing required env, an unreachable Upstash counter, or any upstream error returns the "unavailable" status and never calls the LLM.
- The per-client hourly limit and the global daily cap are enforced before any upstream call. The daily cap key (`cap:<day>`) is SHARED across both proxies; the per-client key prefixes are distinct (`rl:` for `/api/ai`, `rlsql:` for `/api/sql`).
- Proxies log only coarse metadata (status, counts). Never log sample values or the question text.

## Bounded AI influence

- The stitching AI may only nudge an existing match score within a small bounded range and rewrite its one-line reason. It cannot create, apply, approve, or remove proposals. Any AI failure falls back to the deterministic rules engine.
- All AI-provided text is rendered as plain text, never as markup.

## Read-only SQL validator

- Every generated query (LLM, repair, or starter chip) passes through the client-side SQL validator before it reaches DuckDB.
- Accept only a single read-only statement whose first keyword is SELECT or WITH, after stripping comments, string literals, and quoted identifiers.
- Reject a second statement (any non-trailing semicolon), the forbidden keywords (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH, DETACH, COPY, PRAGMA, INSTALL, LOAD, CALL, EXPORT, SET) matched as whole words outside literals and identifiers, and file or network table functions (read_csv, read_parquet, read_json, glob, httpfs-style, and similar).
- Every referenced table must be a current queryable table or a CTE alias from the same statement. Reject string or quoted paths in a table position and dotted references whose qualifier is not exactly `main`.
- Never weaken these checks. Treat all schema text, sample values, and questions as untrusted data.

## Row caps

- The validator enforces a LIMIT when a query has none, and the executor wraps every accepted query so no model-written LIMIT can materialize more than the fetch cap.
- The on-screen result table is capped for display; CSV export covers the full fetched result up to the fetch cap.
