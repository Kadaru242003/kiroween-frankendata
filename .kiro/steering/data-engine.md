---
inclusion: fileMatch
fileMatchPattern: 'src/core/**'
---
# Data engine conventions

Rules for `src/core/**`, the framework-agnostic engine shared by the web app and the MCP server.

## DuckDB

- All data work goes through the `DuckDBService` interface (`src/core/types.ts`). Core modules never import React or touch the DOM.
- The browser uses DuckDB-WASM served locally (Vite `?url` imports). Tests and the MCP server use the node-blocking bundle behind a connection adapter. Core code must work with both.
- Tables are created with explicit types from the inferred `ColumnType` (`COLUMN_TYPE_TO_DUCKDB_TYPE`), never DuckDB auto-typing, with a VARCHAR fallback.
- DATE values from the browser bundle arrive as epoch values. Convert in the data layer (`duckDbDateToIso`) or `CAST(col AS VARCHAR)` in SQL.
- Avoid `GROUP BY` on a `regexp_replace` expression: it crashes the DuckDB-WASM MVP bundle (`_setThrew is not defined`). Group raw values first, then normalize the distinct values. A literal NUL byte in SQL also crashes it.

## SQL safety

- Quote every identifier with `quoteIdent` and every string literal with `quoteString` (`src/core/stitching/sql-escape.ts`). Never interpolate a raw name. Generated aliases (`c0`, `nn3`, and similar) are fine; only finite numbers may be interpolated, through a helper such as `numLit`.
- Model-written SQL always passes `validateSql` and the fetch cap before it reaches DuckDB. Application-built SQL (export, autopsy, appliers) is built only from quoted names and generated values.

## Originals are never mutated

- Cleanups and joins create new tables. Cleaned copies are `stitch_<n>_clean_<table>` and the joined result is `stitch_<n>_result`, where `<n>` is the per-session apply counter. Undo drops exactly the tables an apply created.
- Original tables stay untouched. New code that writes anywhere must use the `stitch_` prefix.
- Cleaning proposal ids are `clean:whitespace|case|category:<table>.<column>`, `clean:duplicate-rows:<table>` and `clean:outliers:<table>.<column>`. Match ids are `match:<a>=<b>` with the two column refs sorted. Recipes and the MCP server rely on these ids, so do not change them.

## Determinism

- Proposals come from the rules engine. The optional AI may only nudge an existing score by plus or minus 0.2 and any AI failure falls back to the rules result. Core output for the same loaded tables must be deterministic.

## Tests

- Every safety or equivalence invariant gets a `*.property.test.ts` file (fast-check v4, one invariant per file, tagged with its design property). DuckDB-backed tests are `*.duckdb.test.ts` and use a node-blocking harness.
- The DuckDB-WASM node bundle is not safe across parallel workers, so `vitest.config.ts` keeps `fileParallelism: false`. Do not change it.
- Golden tests pin demo results (stitching, Ask the Lab, Autopsy, Recipes, MCP). If a golden changes, explain why.
