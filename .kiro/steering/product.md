# Product

FrankenData is a browser-only tool that turns messy CSV and XLSX files into typed, queryable DuckDB tables. The user drags and drops files (or loads bundled demo datasets); each file is parsed in the browser, its columns are typed by a custom inference layer that tolerates real-world mess (currency symbols, thousands separators, percent signs, mixed date formats, `N/A`/`-`/`null` missing-value markers), and the result is loaded as an explicitly typed table in an in-memory DuckDB-WASM database. Each loaded table is shown in a preview with its first 20 rows, column names, inferred types, and total row count.

## Who it's for

Data analysts who want to inspect and query ad-hoc spreadsheets quickly, without uploading anything to a server. Judges and first-time users can click "Load demo data" to see the full pipeline work immediately with no files of their own.

## Privacy

All data stays in the browser. There is no server, no persistence, and no network access during file loading. Refreshing the page discards all tables and resets to an empty state.

## Kiroween 2026 angle

Built for the Kiroween 2026 hackathon, Frankenstein category: the product stitches together mismatched technologies (React, DuckDB-WASM, PapaParse, SheetJS) into one client-side "mad-scientist lab," themed accordingly.

## Scope

This covers file intake only. PDF support, AI matching, chat, and persistence beyond the browser session are out of scope and belong to later specs. Do not add features that do not yet exist.
