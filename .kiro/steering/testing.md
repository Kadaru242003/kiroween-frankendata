---
inclusion: fileMatch
fileMatchPattern: '**/*.test.*'
---

# Testing conventions

Rules for test files in this project.

## Runner

- Tests run on Vitest. `npm test` already passes `vitest --run`, so do not add `--run` again, and do not run watch mode in automation.
- `vitest.config.ts` sets `fileParallelism: false` on purpose: the DuckDB-backed tests cannot share worker threads safely. Do not re-enable file parallelism.
- Tests live next to the module they cover.

## Test kinds and naming

- `*.test.ts` / `*.test.tsx`: example-based unit tests.
- `*.property.test.ts`: property-based tests using fast-check, one invariant per file. Use these for the safety and determinism invariants, for example the SQL validator never accepting a forbidden keyword or a second statement, accepted SQL always carrying a LIMIT, and CSV export round-tripping.
- `*.smoke.test.tsx`: minimal React render checks. Components that depend on DuckDB are tested through fakes, since the browser DuckDB worker is unavailable under jsdom.
- `*.duckdb.test.ts`: DuckDB-backed tests that wrap the node-blocking bundle in a connection adapter. These include the golden regression tests for stitching (`src/core/stitching/stitch-golden.duckdb.test.ts`) and for Ask the Lab (`src/core/chat/ask-golden.duckdb.test.ts`), plus the real-value conversion checks.

## What to keep true

- Keep the test suite lean. Prefer unit and a few property tests over broad end-to-end tests; reserve DuckDB-backed tests for the golden and conversion cases.
- The AI and SQL providers are exercised only through their fake implementations. No test makes a real network call.
- When you change safety-critical logic (the SQL validator, the proxy handlers, result conversion), run the relevant unit and property tests and confirm no check was weakened.

## Running

- Full suite: `npm test`.
- The serverless graph has its own check: `npm run check:api`.
- Before calling a change done, the standard gate is `npm run build`, `npm run lint`, `npm test`, and (for api or proxy changes) `npm run check:api`.
