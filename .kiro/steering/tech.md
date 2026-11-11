# Tech

## Stack

- **React 19** + **Vite** + **TypeScript** — single-page app, runs entirely client-side.
- **DuckDB-WASM** (`@duckdb/duckdb-wasm`) — in-memory SQL engine, in the browser.
- **PapaParse** — CSV parsing.
- **SheetJS** (`xlsx`) — XLSX parsing.
- **Vitest** — test runner.
- **fast-check** (v4) — property-based testing.
- **oxlint** — linting.

## Commands

- `npm test` — runs `vitest --run`. It already passes `--run`, so do not add `--run` again.
- `npm run build` — `tsc -b && vite build`.
- `npm run lint` — oxlint.
- `npm run dev` — Vite dev server (start manually; do not run as a blocking command).

## Constraints and gotchas

- **All data stays in the browser.** No server, no network access during loading.
- **DuckDB-WASM is served locally, not from a CDN.** The browser bundle's Wasm module and worker are imported from the installed package as Vite-fingerprinted `?url` imports (`duckdb-mvp.wasm?url`, `duckdb-browser-mvp.worker.js?url`, etc.). Nothing is fetched from jsDelivr at runtime.
- **DuckDB browser DATE values come back as epoch milliseconds**, not `Date` objects. They are converted to ISO `YYYY-MM-DD` strings in the data layer inside `getPreviewRows` (via `duckDbDateToIso`), so the UI receives ready-to-display strings. Storage is untouched; the fix lives in the data layer, not the UI.
- **fast-check v4** uses `fc.string({ unit: "binary" })` to draw from the full code-point range (older `fc.fullUnicodeString`-style APIs do not apply).
- Tables use explicit typed DDL from the inferred `ColumnType` (never DuckDB auto-typing), with a `VARCHAR` string fallback when a column's values cannot be coerced.
- DuckDB-WASM's browser bundles need a real worker environment unavailable under Vitest's jsdom runner, so DuckDB-backed tests wrap the node-blocking bundle instead.
