# Design Document: FrankenData Recipes and Export

## Overview

This document describes the design of **Feature 5: Recipes and export**. It adds table export (CSV, Excel, Parquet), a savable and appliable "recipe" of a stitch, a SQL script export, a "next month" demo, and a recipe scroll for Little Frank. Everything runs in the browser, with no AI and no network call.

The design follows `.kiro/steering/structure.md`: a framework-agnostic core under `src/core/recipes/` that is unit- and property-tested without React, and React only at the edges under `src/components/recipes/`. Existing stitching, cleaning, apply, Autopsy, and Ask the Lab code is reused through its public functions only. A recipe maps onto the existing proposal types and the existing `StitchStore` decisions, so every recipe result still goes through the existing approval screen.

## Architecture

```
Export buttons --> table-exporter.ts --> DuckDBService.query / exportFileBytes --> download.ts
Save recipe    --> recipe-builder.ts (plan + tables + decisions) --> JSON text --> download
Apply recipe   --> file text --> recipe-validator.ts --> recipe-mapper.ts
                       |                                      |
                       |  (rejected: errors shown, no change) v
                       |                       StitchStore.setProposals(augmented) + setDecision(...)
                       |                       + recipe overrides (anchor, keys) held in App state
                       '----> existing ApprovalScreen (pre-approved) -> Confirm & stitch -> Apply & stitch
Export SQL     --> sql-script.ts (plan + tables) reuses buildCleanedCopySql + buildJoinChainSql
Demo           --> next-month-demo.ts (bundled CSV strings) --> existing intake pipeline
Little Frank   --> SpecimenRegion recipeApplied prop --> Specimen scroll accessory
```

### Module layout

- `src/core/recipes/types.ts`: the `RECIPE_*` and `EXPORT_*` constants, the `Recipe` types, the `NotAppliedItem` and `RecipeMapping` types.
- `src/core/recipes/recipe-validator.ts`: `validateRecipeText(text)` and `validateRecipeValue(value)`.
- `src/core/recipes/recipe-builder.ts`: `buildRecipe(input)`, `serializeRecipe(recipe)`, `recipeFileName(date)`.
- `src/core/recipes/recipe-mapper.ts`: `mapRecipeTables`, `mapRecipeItems`, `mapRecipe`, `applyRecipeOverrides`, `assemblePlanFromMapping` (used by tests and the plan round trip).
- `src/core/recipes/table-exporter.ts`: `exportTable(db, table, format)`, `toCsvText`, `exportFileName`, `toXlsxBytes`.
- `src/core/recipes/sql-script.ts`: `buildSqlScript(input)`, `sqlScriptFileName(date)`.
- `src/core/recipes/next-month-demo.ts`: `loadNextMonthFiles()` and the bundled CSV strings.
- `src/core/recipes/duckdb-test-harness.ts` (test support): node-blocking harness with `exportFileBytes`.
- `src/components/recipes/ExportButtons.tsx`, `RecipePanel.tsx`, `RecipeNotApplied.tsx`, their CSS, `download.ts` (bytes download), and `review.ts` (explicit scroll helper).

### Edits to existing files (all additive)

- `src/core/stitching/match-scoring.ts`: `export` the existing `pairId` function (no behavior change).
- `src/core/types.ts` and `src/db/duckdb-service.ts`: an optional `exportFileBytes` on `DuckDBService` and `DuckDBConnectionAdapter`, implemented only in the browser connection.
- `src/core/chat/demo-loader.ts`: the `DemoId` union gains `"nextMonth"`.
- `src/components/TablePreview.tsx`: an optional `renderActions` prop.
- `src/components/Specimen.tsx` and `.css`: an optional `recipeApplied` prop and the scroll.
- `src/App.tsx`: recipe state, handlers, the new demo button, the new regions.

## Recipe JSON schema (version 1)

```json
{
  "format": "frankendata-recipe",
  "version": 1,
  "createdAt": "2026-11-11T10:00:00.000Z",
  "tables": [
    { "name": "monsters", "columns": [{ "name": "Monster_Name", "type": "string" }] }
  ],
  "matches": [
    {
      "left":  { "table": "monsters",    "column": "Monster_Name" },
      "right": { "table": "experiments", "column": "monster_name" },
      "confidence": 0.95,
      "edited": false
    }
  ],
  "cleanings": [
    { "rule": "category", "table": "monsters", "column": "Species", "canonical": "Swamp Wraith", "edited": false },
    { "rule": "duplicate-rows", "table": "monsters" }
  ],
  "join": {
    "anchor": "monsters",
    "keys": [
      {
        "left":  { "table": "monsters",    "column": "Monster_Name" },
        "right": { "table": "experiments", "column": "monster_name" }
      }
    ]
  }
}
```

Field rules:

- Every object has an exact key set. Required keys are required, optional keys are `column` (required for `whitespace`, `case`, `category`, `outliers`, forbidden for `duplicate-rows`), `canonical` and `edited` (only for `category`).
- `type` is one of `number`, `boolean`, `date`, `string`.
- `confidence` is a finite number in 0..1.
- `join.keys[i]` must correspond to a listed match (same unordered column pair). `join.anchor` must be a listed table.
- There is no field that holds a row value, a file name, or SQL. Variant maps are not stored.

## Validator

`validateRecipeText(text: string): ValidationResult` where `ValidationResult = { ok: true; recipe: Recipe } | { ok: false; errors: RecipeIssue[] }` and `RecipeIssue = { path: string; message: string }`.

Algorithm:

1. Reject when the UTF-8 byte length exceeds `RECIPE_MAX_BYTES` (checked with `TextEncoder` length, before parsing).
2. `JSON.parse` in a try/catch. Reject non-JSON.
3. `validateRecipeValue(value)` walks the value with explicit checkers. Each checker takes an `unknown`, uses `Object.keys` to compare the key set with the allowed set (unknown keys produce an issue at that path), checks the primitive types, and copies the values into a fresh object literal. Names that equal `__proto__`, `constructor`, or `prototype` are rejected. Counts and lengths are checked against the constants.
4. Cross references: sets of table names and per-table column sets are built, and every reference is looked up. Duplicate table names and duplicate column names within a table are issues.
5. The function collects issues (capped at 50 internally) and never throws; the whole body is also wrapped so an unexpected exception becomes an issue. The UI shows the first 5.

`JSON.parse` of `__proto__` as an own key creates an own property, not a prototype change, and the validator only reads known keys, so the output is built from fresh objects and is safe.

## Builder

`buildRecipe({ plan, tables, decisions, now }): Recipe`.

- `tables`: the loaded tables whose names appear in the plan (anchor, matches, cleanings), in name order, each as `{ name, columns: schema }`. Only names and types.
- `matches`: `plan.approvedMatches`, sorted by the id computed from the columns. `edited` is true when the decision for the match id is `edited`. `confidence` is clamped to 0..1.
- `cleanings`: `plan.approvedCleanings` mapped with `ruleOf(proposal)`: `whitespace-case` with no `variantMap` is `whitespace`; `whitespace-case` with a `variantMap` is `case`; `category-standardize` is `category` (with `canonical`, and `edited` true when the decision is `edited` and carries a `canonical`); `duplicate-rows` and `outliers` map to themselves. Sorted by rule, table, column.
- `join`: `anchor = plan.anchorTableName`; `keys` from `plan.joinKeysByPair` values, each resolved to its match in `plan.approvedMatches` and written as that match's left and right column refs. Keys whose match is missing are dropped.

`serializeRecipe` is `JSON.stringify(recipe, null, 2) + "\n"`. The builder is deterministic given `now`.

## Mapper

Types:

```ts
type NotAppliedCode =
  | "table-not-found" | "table-ambiguous" | "column-missing" | "type-changed"
  | "no-longer-detected" | "anchor-unmapped" | "key-unmapped";
interface NotAppliedItem { kind: "match" | "cleaning" | "anchor" | "key"; description: string; code: NotAppliedCode; reason: string }
interface RecipeMapping {
  proposals: ProposalSet;                       // current proposals plus recipe-built matches
  decisions: ApprovalDecision[];                // pre-approved, in a stable order
  overrides: { anchor?: string; joinKeysByPair: Record<string, string> };
  notApplied: NotAppliedItem[];
  mappedCount: number;                          // matches + cleanings that got a decision
  tableMap: Record<string, string>;             // recipe table name -> loaded table name
}
```

### Table mapping (`mapRecipeTables`)

For each recipe table, in order:

1. If a loaded table has the same `tableName`, map to it.
2. Otherwise collect the loaded tables not already mapped whose column names and types equal the recipe table's as sets. If exactly one, map to it. If more than one, mark `table-ambiguous`. If none, `table-not-found`.

Unmapped recipe tables are stored with their code. Because step 1 runs for all tables before step 2, a same-name table is never taken by another recipe table's step 2.

### Item mapping (`mapRecipeItems`)

Helper `resolveCol(ref)` returns `{ ok, loadedTable, column, type }` or `{ code, reason }`:

- table unmapped: the table's code (`table-not-found` or `table-ambiguous`) with a reason such as `Table "monsters" is not loaded.`;
- column missing in the mapped table: `column-missing`;
- type differs from the recipe type: `type-changed` with both types in the reason.

Matches:

- Resolve both sides; any failure puts the match in `notApplied` with the failing code.
- Build the `MatchProposal` id with the exported `pairId` from the mapped refs.
- Not edited: if `proposals.matches` has that id, use it as is with decision `approved`; otherwise build a new `MatchProposal` (`confidence` from the recipe, `reason: "From recipe"`, `source: "rules"`, zero components) and add it to the augmented proposal set with decision `approved`.
- Edited: find a current proposal that shares exactly one endpoint with the recipe match (same table and column on one side, same table on the other side, different column). If found, emit decision `edited` for that proposal's id with `edit: { left, right }` set to the recipe's mapped refs. If not found, treat as not edited (build and approve a new proposal).

Cleanings, per `ruleId(rule, table, column)` (`clean:whitespace:T.col`, `clean:case:T.col`, `clean:category:T.col`, `clean:duplicate-rows:T`, `clean:outliers:T.col`, using the mapped names):

- Resolve the column (when present); failures go to `notApplied`.
- If `proposals.cleanings` has the id, emit `approved`. For `category` with `edited` and a `canonical` that differs from the proposal's `canonical`, emit `edited` with `edit: { canonical, variantMap }` where `variantMap` is the current map with every value equal to the proposal's canonical replaced by the recipe canonical.
- If not present: `no-longer-detected` with a reason such as `Nothing to clean here in the current data.`.

Join:

- Anchor: map through `tableMap`. If unmapped, `anchor-unmapped`. Otherwise `overrides.anchor`.
- Each key: resolve both sides; compute the proposal id of the matching approved match (the id of the proposal whose decision was emitted for that unordered pair, edited ones by their proposal id). If found, `overrides.joinKeysByPair[pairKey(a, b)] = id` (using `pairKey` from `plan-assembly`). Otherwise `key-unmapped`.

The mapper is pure: no DuckDB, no store access. `mapRecipe(recipe, tables, proposals)` composes the two steps and sorts `notApplied` in recipe order. Every recipe match, cleaning, anchor, and key either yields a decision (or override) or exactly one `notApplied` entry, which gives Requirement 4.8.

### Plan assembly

`assemblePlanFromMapping(mapping, tables)` calls the existing `assembleStitchPlan(mapping.proposals, decisionsById, tables, { anchorTableName, joinKeysByPair })`. The UI path uses `applyRecipeOverrides(plan, overrides)` after the user confirms on the approval screen: it sets `anchorTableName` when the named table is among the plan's tables, and merges the key map entries whose match id is in `plan.approvedMatches`. Both paths are pure and produce a plan of the existing `StitchPlan` type.

## Export implementations

### Fetching rows

`readTable(db, table)` runs `SELECT <select list> FROM <quoteIdent(table.tableName)>` where each date column is selected as `CAST(<quoteIdent(col)> AS VARCHAR) AS <quoteIdent(col)>` (the DuckDB-WASM browser bundle returns raw epoch values for DATE otherwise). Number cells are converted with `Number`, `bigint` with `Number`, booleans stay booleans, strings stay strings, and `null` stays `null`. The columns come from `table.schema`.

### CSV

`toCsvText(columns, rows)` reuses the existing RFC 4180 `toCsv` from `src/core/chat/csv-export.ts` after mapping `null` to the empty string. The text is prefixed with nothing (no BOM), and the download is `text/csv`.

### Excel

`toXlsxBytes(table, rows)` builds a worksheet with SheetJS (`xlsx`, already a dependency): a header row and typed cells (`t: "n"`, `"b"`, `"s"`, and dates as `t: "d"` from the ISO string with `cellDates`), NULL as an absent cell. The sheet name is the table name reduced to the allowed Excel characters and 31 characters. More than `EXPORT_MAX_ROWS` rows is refused with a clear message.

### Parquet

`exportParquet(db, table)`:

1. Build a virtual file name `frankendata_export_<counter>.parquet` from an in-module counter (never from user text).
2. `COPY (SELECT * FROM <quoteIdent(table.tableName)>) TO '<virtual name>' (FORMAT PARQUET)`; the virtual name is quoted with `quoteString`.
3. `db.exportFileBytes(sql, virtualName)` runs the COPY, reads the bytes with `copyFileToBuffer`, and drops the virtual file with `dropFile` in a `finally`.

`exportFileBytes` is optional on the service. When absent (a service without browser file access), Parquet export reports "Parquet export is not available in this environment". In the browser connection it is implemented over the `AsyncDuckDB` instance (`connection.query`, `db.copyFileToBuffer`, `db.dropFile`).

### File names

`exportFileName(tableName, format)`: `stem = tableName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")`, falling back to `table`, then `${stem}.${ext}`.

### Download

`downloadBytes(filename, mime, bytes)` in `src/components/recipes/download.ts` creates a Blob URL, clicks a temporary anchor, and revokes the URL, like the existing Autopsy helper. Text downloads reuse `downloadText` from `src/components/autopsy/download.ts`.

## SQL script generation

`buildSqlScript({ plan, tables, now }): string`. Fixed apply counter `SCRIPT_APPLY_COUNTER = 1`.

Structure:

```
-- FrankenData SQL script
-- Generated 2026-11-11
-- Replace each '/path/to/...' placeholder with the real path of your file.
-- Run with DuckDB (https://duckdb.org). Statements run top to bottom.

-- Step 1: load "monsters" (from monsters.csv)
CREATE TABLE "monsters" ("Monster_Name" VARCHAR, ...);
INSERT INTO "monsters" SELECT <typed expr> FROM read_csv('/path/to/monsters.csv', header = true, all_varchar = true, names = ['Monster_Name', ...]);

-- Step 2: cleaned copies
CREATE TABLE "stitch_1_clean_monsters" (...);
INSERT INTO "stitch_1_clean_monsters" ... ;

-- Step 3: join
CREATE TABLE "stitch_1_result" AS SELECT ... LEFT JOIN ...;
```

- Step 1 per table in the plan (tables that appear in the plan): typed `CREATE TABLE` using `COLUMN_TYPE_TO_DUCKDB_TYPE` and `quoteIdent`; the insert reads the file as text and converts with a best-effort expression per type: `string` as is; `number` as `TRY_CAST(regexp_replace(<col>, '[$,€£% ]', '', 'g') AS DOUBLE)`; `boolean` as a `CASE lower(trim(<col>))` over yes/true/1/y and no/false/0/n; `date` as `TRY_CAST(<col> AS DATE)`. A comment states that FrankenData's own parsing is more tolerant (percent values are stored as fractions by the app, and mixed date formats are normalized), so the script is a faithful structure and a best-effort load.
- Step 2 uses `buildCleanedCopySql(1, table, schema, groupApprovedForTable(schema, cleanings))` for tables with approved cleanings, emitting `createSql` and `insertSql` verbatim. These builders already quote everything.
- Step 3 uses `buildJoinChainSql(1, joinInputs, plan.approvedMatches, plan.anchorTableName)` with `joinInputs` built exactly like the applier does (the cleaned copy as `readTableName` when approved cleanings exist). `createSql` is emitted verbatim.
- Quoting: identifiers use `quoteIdent`; the placeholder path and the `names` list use `quoteString`. Comments use `commentSafe(text)`, which replaces any control character and any run of whitespace with a single space and removes `*/`, `/*`, and newlines, so a name can never end the comment line.
- Each statement ends with `;` on its own, and the file ends with a newline. There are no row values in the script. Variant maps appear only as the `CASE` literals the existing builder emits.

A test tokenizer (quote-aware, comment-aware) splits the script and checks the statement count.

## Next month demo

`next-month-demo.ts` holds two inline CSV strings named `monsters.csv` and `experiments.csv` with the same headers as the mismatched demo (`Monster Name,Species,Threat Level,Sedated` and `monster_name,species,danger_level,hazardous`). The rows are different: new creature names (for example Bogsworth, Quill, Murk, Hollow, Pinch), a new species `Bog Hag` with spelling variants (`bog hag`, `BOG  HAG`), new variants of existing species, three exact duplicates of one new row in monsters and one duplicate in experiments, and the same boolean columns. Names are shared across the two files so the headline match is detected. `loadNextMonthFiles()` returns `File` objects like `materialize`. It is added to the existing demo loader as the `nextMonth` provider.

## Little Frank integration

`SpecimenRegion` gains an optional `recipeApplied` prop passed from App and forwarded to `Specimen`. `Specimen` renders a small SVG scroll (a rolled parchment with two lines and a green ribbon) in the held-item slot when `recipeApplied` is true and `autopsyOpen` is false, before the chart sign and clipboard conditions. It is `aria-hidden`, has no animation, and its CSS has no motion. App derives `recipeApplied` from a state `recipeBase` (the stitched table descriptor at the time the recipe was applied, or `null`): `recipeApplied = recipeBase !== undefined && stitchedTable === recipeBase.stitched`. A new stitch or Reset changes or clears it.

## UI behavior

- `ExportButtons` (per table, via `TablePreview`'s `renderActions`, and for the stitched result in `RecipePanel`): three buttons (CSV, Excel, Parquet) with `aria-label` `Export <table> as CSV`, a busy state, and a polite live region with the result message ("Exported monsters.csv" or the error). No focus change, no scroll.
- `RecipePanel`: a "Recipes" section rendered when at least one table exists. Contains "Apply recipe" (a labelled file input styled as a button plus drop support), the apply summary ("N proposals pre-approved, M not applied") with a "Review in stitching table" button, the `RecipeNotApplied` list, validation errors (first 5 with paths), and, when a stitched result exists, "Save recipe", "Export SQL script", and the stitched result export buttons. One polite live region for all messages.
- `RecipeNotApplied`: a list titled "Not applied", one row per item with the description and the reason, plain text. It is also rendered inside the stitching section above the approval screen while a mapping exists.
- Apply flow in App (`handleApplyRecipe(text)`): validate; on failure show errors and stop. Otherwise `mapRecipeTables`, make the mapped tables checked (same technique as the existing Fix it handler), `computeProposals()`, `mapRecipeItems`, `store.setProposals(mapping.proposals, store.getDatasetVersion(), false)`, `setDecision` for each decision, keep the overrides and the not applied list in state, and set `recipeBase`. The approval screen is not opened and the page does not scroll.
- `handleConfirmPlan` applies `applyRecipeOverrides` to the assembled plan when overrides exist, then holds it as the working plan like today.
- "Review in stitching table" opens the approval screen the same way the existing flow does (`cleanupOnly` when fewer than two tables are loaded) and calls `scrollToStitchScreen()`, which scrolls the screen into view (instant under `prefers-reduced-motion`).
- Reset lab clears the recipe state.

## Error handling

- Validation failures: shown in place, nothing changes.
- Mapping never throws; every unmappable item is a `notApplied` entry.
- `computeProposals` failure: a message "Could not prepare proposals for the recipe", no state change beyond what the controller did.
- Export failures: message in place, per table.
- Downloads are wrapped like the existing helper, so a blocked download never crashes the app.

## Correctness properties and tests

| Property | Test file |
| --- | --- |
| 1 round trip (plan to recipe to mapping to equivalent plan) | `recipe-roundtrip.property.test.ts` |
| 2 same stitched result for the same tables | `recipes-golden.duckdb.test.ts` (golden), with the assertions pinned |
| 3 hostile recipes rejected, no side effects | `recipe-validator.hostile.property.test.ts` |
| 4 CSV round trip | `table-exporter.csv.property.test.ts` |
| 5 SQL script quoting | `sql-script.quoting.property.test.ts` |
| 6 safe file names | `table-exporter.filename.property.test.ts` |

Other tests: `recipe-validator.test.ts` (each rule), `recipe-builder.test.ts`, `recipe-mapper.test.ts` (every code), `table-exporter.test.ts` (CSV, XLSX read back with SheetJS), `table-exporter.duckdb.test.ts` (Parquet bytes start with `PAR1` and read back through DuckDB), `sql-script.test.ts` and `sql-script.duckdb.test.ts` (the generated statements run in DuckDB over temp CSV files and reproduce the app's stitched result), `next-month-demo.test.ts`, UI smoke tests (`ExportButtons.smoke.test.tsx`, `RecipePanel.smoke.test.tsx` for invalid upload and the not applied list), and the Specimen scroll test.

Golden test: with the mismatched demo loaded, plan the stitch (all proposals approved, as the app's flow would), apply, build a recipe, undo and reset, load the next month demo, compute proposals, map the recipe, assemble the plan, apply, and pin the expected result (columns, row count, selected rows, not applied list).

## Security notes

- The only parse of untrusted text is `JSON.parse` followed by the validator. There is no `eval`, no `Function`, no dynamic key access with untrusted keys, and no SQL in the schema.
- Recipe names reach SQL only after being matched to existing loaded table and column names (the mapper resolves every reference against `LoadedTable`s) and are then quoted by the existing builders. A recipe name that is not a loaded name never reaches SQL.
- Recipe text is rendered as React text, never as markup.
- Exports and the script never include more than the user's own table contents (exports) or no row values (recipe and script).
