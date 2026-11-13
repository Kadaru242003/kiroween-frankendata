# Implementation Plan: FrankenData Autopsy

## Overview

Feature 4 adds "The Autopsy": a data quality report for any loaded table or stitched result, computed in the browser with aggregate DuckDB SQL and the existing cleaning rules, with a transparent health score, Fix it actions that feed the existing approval flow, Markdown and JSON export, and a magnifying-glass pose for Little Frank. The plan builds the framework-agnostic core first (types and SQL, then the score, then Fix it), then the UI, exports, and Little Frank, then property and golden tests, per `.kiro/steering/structure.md`.

**Conventions:**
- Property tests use `fast-check`, one invariant per file, with the property tag in the header comment.
- DuckDB-backed tests wrap the node-blocking bundle through the shared test harness added in task 1.
- No existing core behavior changes. Tiny additive exports and optional props are listed in `NOTES.md`.
- Checkpoints run `npm run build` and the tests for the touched files; the final task runs the full suite, lint, and `npm run check:api`.

## Tasks

- [ ] 1. Types, constants, SQL builders, and the DuckDB test harness
  - Create `src/core/autopsy/types.ts` with the `AUTOPSY_*` constants and the report types from the design
  - Create `src/core/autopsy/autopsy-sql.ts`: `numLit`, and pure builders for stage A, duplicates, top values, string variants, and outliers, using only `quoteIdent` and generated aliases
  - Create `src/core/autopsy/duckdb-test-harness.ts` (node-blocking adapter) shared by the DuckDB-backed autopsy tests
  - Unit tests: quoting of hostile identifiers, `numLit` rejects non-finite numbers, aliases are generated
  - _Design: Data model, SQL strategy; Requirements 2.10, 7.1, 7.2_

- [ ] 2. Health score and column status
  - Create `src/core/autopsy/health-score.ts`: `computeHealth` (the seven deductions, caps, clamp) and `columnStatus` (the thresholds)
  - Unit tests: each deduction and cap, the worked example (score 81), clamp at 0, status thresholds including the boundaries
  - Property test (own file): the HealthScore is an integer in 0 to 100 for arbitrary inputs
  - _Design: Health score; Requirements 4.1 to 4.4, 9.1_

- [ ] 3. Pure report assembly
  - In `autopsy-engine.ts`, add pure `buildColumnFinding` and `assembleReport` that turn raw stage results into findings (null percent, derived keys, all-null, constant columns, date epoch conversion)
  - Unit tests: null percent with zero rows, candidate keys, all-null, constant, empty-table rules, date conversion
  - Property test (own file): `nullPct` equals `nullCount / rows * 100` (zero when rows is zero) for arbitrary counts
  - _Design: Data model; Requirements 2.1, 3.2 to 3.5, 9.2_

- [ ] 4. The engine: staged read-only queries and progress
  - Add `runAutopsy(db, target, options)` implementing stages A, duplicates, B, and C, the row cap, error handling, and `onProgress`
  - Unit tests on small hand-made tables: nulls, distinct, top values ordering, numeric statistics, date statistics, whitespace and case variants, outliers with examples, duplicates, too-large message, failed query yields an error report without throwing
  - _Design: SQL strategy, Error handling, Performance; Requirements 2, 3, 7_

- [ ] 5. Fix it mapping
  - Create `src/core/autopsy/fix-it.ts`: `buildFixActions` using `createSampleReader` and `cleanTables`, keeping whitespace, category, and duplicate proposals
  - Wire stage C of the engine to it, honoring `allowFixes`
  - Unit tests: action ids and kinds on a small table, no actions for a clean table, none when `allowFixes` is false
  - _Design: Fix it mapping; Requirements 5.1, 5.2, 5.5_

- [ ] 6. Markdown and JSON export
  - Create `src/core/autopsy/report-export.ts`: `toMarkdown` (with escaping) and `toJson`
  - Unit tests: JSON round trip equals the report, Markdown contains the score and breakdown, hostile names cannot start a heading or table row
  - _Design: UI layout; Requirements 6_

- [ ] 7. CaseFilePanel UI and the TablePreview entry point
  - Create `src/components/autopsy/CaseFilePanel.tsx`, `.css`, and `download.ts`: progressive rendering, status badges with text, breakdown, table findings, per-column details, Fix it buttons, export buttons, live region, error and too-large states, reduced motion
  - Add the optional `onAutopsy` prop and the "Autopsy" button to `TablePreview` cards
  - Smoke tests: partial then complete render, too-large message, error and retry, export buttons call the download helper, Fix it button invokes its callback, the TablePreview button
  - _Design: UI layout; Requirements 1, 5.3, 6, 8_

- [ ] 8. App integration and cleanup-only Fix it flow
  - In `App.tsx`: autopsy target state, render the panel, close it when its table disappears, `handleFixIt`, and the `cleanupOnly` flag so the approval screen opens with one table
  - Keep all existing stitching behavior unchanged for two or more tables
  - _Design: Fix it mapping; Requirements 1.2 to 1.6, 5.3, 5.4, 5.6_

- [ ] 9. Little Frank magnifying glass
  - Add the optional `autopsyOpen` prop to `Specimen` and `SpecimenRegion`, the magnifying-glass accessory, and the `specimen--investigating` class
  - Smoke test: the glass shows when open and the chart sign and clipboard are suppressed
  - _Design: Little Frank integration; Requirement 8.5_

- [ ] 10. **Checkpoint**
  - Run `npm run build` and the autopsy, TablePreview, and Specimen tests; fix any failures

- [ ] 11. DuckDB property tests
  - Determinism, no-mutation, applier acceptance, and adversarial identifiers, each in its own file with small run counts
  - _Design: Correctness properties and tests; Requirements 9.3 to 9.6_

- [ ] 12. Golden test and performance test
  - `autopsy-golden.duckdb.test.ts`: pin the mismatched demo monsters findings (14 rows, 2 duplicate rows, species whitespace and case variants, score) and the experiments table
  - Performance test: 100,000 rows by 20 columns measured against `AUTOPSY_TARGET_MS`
  - _Design: Performance, Correctness properties and tests; Requirements 7.4, 9.7_

- [ ] 13. Final checks and notes
  - Run the full `npm test`, `npm run build`, `npm run lint`, and `npm run check:api`; fix failures
  - Write `NOTES.md`
  - _Requirements: all_
