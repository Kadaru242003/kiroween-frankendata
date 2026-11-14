# Implementation Plan: FrankenData Recipes and Export

## Overview

Feature 5 adds table export (CSV, Excel, Parquet), savable and appliable recipes, a SQL script export, a "next month" demo, and a recipe scroll for Little Frank. The plan builds the framework-agnostic core first (types, validator, builder, mapper, exporter, script, demo), then the UI edges, then App integration and Little Frank, then property, golden, and smoke tests, per `.kiro/steering/structure.md`.

**Conventions:**

- Property tests use `fast-check`, one invariant per file, with the property tag in the header comment.
- DuckDB-backed tests wrap the node-blocking bundle through the harness in `src/core/recipes/duckdb-test-harness.ts`.
- No existing core behavior changes. Tiny additive exports and optional props are listed in `NOTES.md`.
- Checkpoints run `npm run build` and the tests for the touched files; the final task runs the full suite, lint, and `npm run check:api`.

## Tasks

- [x] 1. Types, constants, and the small additive exports
  - Create `src/core/recipes/types.ts` with the `RECIPE_*` and `EXPORT_*` constants, the `Recipe` types, `NotAppliedItem`, `RecipeMapping`
  - Export the existing `pairId` from `match-scoring.ts`
  - Add the optional `exportFileBytes` to `DuckDBService` and `DuckDBConnectionAdapter`, implemented in the browser connection
  - Create the node-blocking test harness with `exportFileBytes`
  - _Design: Module layout, Edits to existing files; Requirements 1.5, 9.3_
- [x] 2. Recipe validator
  - Create `recipe-validator.ts` with `validateRecipeText` and `validateRecipeValue`
  - Unit tests for every rule: size, non-JSON, non-object, unknown fields, wrong types, format, version (older and newer), limits, cross references, duplicates, hostile keys, totality
  - _Design: Validator; Requirements 3.1 to 3.9_
- [x] 3. Recipe builder
  - Create `recipe-builder.ts` with `buildRecipe`, `serializeRecipe`, `recipeFileName`
  - Unit tests: only approved and edited items, no row values, key resolution, deterministic output, the built recipe passes the validator
  - _Design: Builder; Requirements 2.2 to 2.9_
- [x] 4. Recipe mapper
  - Create `recipe-mapper.ts` with `mapRecipeTables`, `mapRecipeItems`, `mapRecipe`, `applyRecipeOverrides`, `assemblePlanFromMapping`
  - Unit tests for every NotApplied code, name then schema mapping, ambiguous tables, edited match, edited canonical, recipe-built matches, anchor and key overrides, nothing dropped silently
  - _Design: Mapper, Plan assembly; Requirements 4.2 to 4.6, 4.8, 4.10 to 4.12_
- [x] 5. Property tests for the recipe core
  - Property 1 round trip (plan to recipe to mapping to equivalent plan)
  - Property 3 hostile recipes (validator never throws; mutated valid recipes; no store side effects on rejection)
  - _Design: Correctness properties; Requirements 10.1, 10.3, 10.7_
- [x] 6. Table exporter
  - Create `table-exporter.ts`: `readTable`, `toCsvText`, `toXlsxBytes`, `exportParquet`, `exportTable`, `exportFileName`
  - Unit tests: CSV quoting, NULL as empty, ISO dates, XLSX read back with SheetJS (types), XLSX row cap message, Parquet unavailable message
  - Property 4 (CSV round trip with the app's CSV parser) and Property 6 (safe file names)
  - _Design: Export implementations; Requirements 1.2 to 1.8, 10.4, 10.6_
- [x] 7. DuckDB-backed export tests
  - Parquet bytes start with `PAR1`, read back through DuckDB with the same rows; the virtual file is dropped; the source table is unchanged
  - _Design: Parquet; Requirements 1.5, 1.10_
- [x] 8. SQL script builder
  - Create `sql-script.ts`: `buildSqlScript`, `sqlScriptFileName`, `commentSafe`
  - Unit tests: structure, placeholders, reuse of the existing builders, no row values
  - Property 5 (every identifier quoted, adversarial names never create a statement boundary)
  - _Design: SQL script generation; Requirements 5.1 to 5.7, 10.5_
- [x] 9. Next month demo data and loader hook
  - Create `next-month-demo.ts` and extend `DemoId` with `"nextMonth"`
  - Unit tests: two files with the expected names and headers, different rows from the mismatched demo, offline, shared creature names
  - _Design: Next month demo; Requirements 6.1 to 6.4_
- [x] 10. Golden DuckDB tests
  - Month one stitch, build recipe, undo, reset, load month two, map, assemble, apply, pin the result (Property 2) and the NotApplied list
  - Same-table equivalence: recipe applied to the same tables gives an identical result
  - SQL script reproduces the stitched result when run in DuckDB over the same CSV text
  - _Design: Golden test; Requirements 4.11, 6.5, 10.2_
- [x] 11. Checkpoint: run `npm run build` and all core recipe tests, then commit
- [x] 12. UI components
  - Create `ExportButtons`, `RecipePanel`, `RecipeNotApplied`, `download.ts` (bytes), `review.ts`, and CSS
  - Add the optional `renderActions` prop to `TablePreview`
  - Smoke tests: export buttons call the exporter and show feedback without scrolling; invalid recipe upload shows errors and changes nothing; the not applied list renders; Save recipe and Export SQL appear only with a stitched result
  - _Design: UI behavior; Requirements 1.1, 1.8, 1.9, 2.1, 3.8, 4.7, 4.8, 8.1 to 8.3_
- [x] 13. Little Frank recipe scroll
  - Add the optional `recipeApplied` prop, the scroll SVG, and the priority rules to `Specimen`
  - Tests: scroll shows, hidden when the magnifier shows, default off
  - _Design: Little Frank integration; Requirements 7.1 to 7.3_
- [x] 14. App integration
  - Wire the recipe state, `handleApplyRecipe`, the override on confirm, the review button, the new demo button, the recipe regions, reset handling, and `recipeApplied`
  - A DuckDB-level test of the apply handler logic through the core functions
  - _Design: UI behavior, Little Frank integration; Requirements 4.7, 4.9, 6.1, 6.4, 7.1_
- [x] 15. Final checks and notes
  - Run the full test suite, `npm run build`, `npm run lint`, and `npm run check:api`
  - Write `NOTES.md` and commit
  - _Requirements: all_

## Follow-up (placement fix)

- [x] 16. Drop Parquet from the UI and exporter; move the Recipes panel above Ask the Lab; move Apply recipe to the top area
