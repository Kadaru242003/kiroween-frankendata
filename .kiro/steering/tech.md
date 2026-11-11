# Tech

## Stack

- **React 19** + **Vite** + **TypeScript** — single-page app, runs entirely client-side.
- **DuckDB-WASM** (`@duckdb/duckdb-wasm`) — in-memory SQL engine, in the browser.
- **PapaParse** — CSV parsing.
- **SheetJS** (`xlsx`) — XLSX parsing.
- **Vitest** — test runner.
- **fast-check** (v4) — property-based testing.
- **oxlint** — linting.
- **Vercel serverless function** (`api/ai.ts`) — the optional `/api/ai` AI proxy; the only server-side code. The app itself still runs entirely client-side.
- **Upstash Redis** (REST API) — rate limiting + global daily cap for the proxy only.

## Commands

- `npm test` — runs `vitest --run`. It already passes `--run`, so do not add `--run` again.
- `npm run build` — `tsc -b && vite build`.
- `npm run lint` — oxlint.
- `npm run dev` — Vite dev server (start manually; do not run as a blocking command).

## The `/api/ai` proxy and env vars

The optional LLM match-refinement enhancement is reached only through a serverless proxy at `/api/ai` (`api/ai.ts`). The LLM API key lives **server-side only** and never reaches the browser. All config is read from `process.env` at runtime (provider and model are env-driven — no hard-coded model). Relevant environment variables (see `.env.example`):

- `VITE_AI_ENABLED` — the only client-visible flag (`VITE_` prefix). The app attempts AI only when it is exactly `"true"`; anything else (unset/`"false"`) is rules-only with no network attempt. Default: off.
- `AI_PROVIDER` — which LLM provider the proxy talks to (e.g. `openai`), server-side only.
- `AI_MODEL` — the model id; fully env-driven, no default.
- `OPENAI_API_KEY` — the LLM provider API key, server-side only, never shipped to the client.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — Upstash REST credentials for rate limiting + the daily cap; if missing/unreachable the proxy fails closed (no LLM call).
- `IP_HASH_SALT` — secret salt used to hash the client IP for the per-client rate-limit key; the raw IP is never stored.

## Deterministic-engine / offline-fallback rule

- All stitching proposals come from the deterministic rules engine. The optional AI only nudges match scores by ±0.2 and only for already-visible candidates — it never adds, removes, or resurrects proposals.
- Any AI failure, timeout, oversized payload, or `VITE_AI_ENABLED` off falls back to the rules-only result. The app always works fully offline; removing the proxy/provider leaves it fully functional.

## Constraints and gotchas

- **All data stays in the browser.** No server, no network access during loading. The `/api/ai` proxy is the only network call, is optional, and sends only budgeted non-NULL sample values (never raw files).
- **DuckDB-WASM is served locally, not from a CDN.** The browser bundle's Wasm module and worker are imported from the installed package as Vite-fingerprinted `?url` imports (`duckdb-mvp.wasm?url`, `duckdb-browser-mvp.worker.js?url`, etc.). Nothing is fetched from jsDelivr at runtime.
- **DuckDB browser DATE values come back as epoch milliseconds**, not `Date` objects. They are converted to ISO `YYYY-MM-DD` strings in the data layer inside `getPreviewRows` (via `duckDbDateToIso`), so the UI receives ready-to-display strings. Storage is untouched; the fix lives in the data layer, not the UI.
- **fast-check v4** uses `fc.string({ unit: "binary" })` to draw from the full code-point range (older `fc.fullUnicodeString`-style APIs do not apply).
- Tables use explicit typed DDL from the inferred `ColumnType` (never DuckDB auto-typing), with a `VARCHAR` string fallback when a column's values cannot be coerced.
- DuckDB-WASM's browser bundles need a real worker environment unavailable under Vitest's jsdom runner, so DuckDB-backed tests wrap the node-blocking bundle instead.
