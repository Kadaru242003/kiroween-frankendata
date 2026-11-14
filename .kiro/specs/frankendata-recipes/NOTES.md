# Recipes and export: run notes

## Summary

Feature 5 adds:

- Export of any loaded table or stitched result as CSV, Excel (.xlsx) and Parquet, from per-table buttons and from the Recipes panel.
- Save recipe after a stitch: a versioned JSON of table schemas (names and types only), approved and edited matches, approved cleanups, anchor and join keys. No row values, no SQL.
- Apply recipe: strict validation, mapping onto loaded tables by name then by column schema, pre-approved decisions in the existing StitchStore, a "Not applied" list with reasons, and an explicit "Review in stitching table" button. A recipe never stitches on its own.
- Export SQL script: a DuckDB script that reproduces the cleanups and the join, built by reusing `buildCleanedCopySql` and `buildJoinChainSql`.
- A "Load next month's files" demo and a recipe scroll for Little Frank.

Core lives in `src/core/recipes/`, UI in `src/components/recipes/`. The apply logic is in `recipe-apply.ts` so it is tested with a real StitchStore and a real DuckDB, not only through React.

## Decisions made without asking

- Recipes map onto EXISTING proposal ids (`clean:<rule>:<table>.<col>`, `match:<a>=<b>`). A recipe stores rules and column refs, never ids, so ids are always derived from validated names.
- A recipe match that is not in the current proposal set is built as a normal `MatchProposal` (reason "From recipe", `source: "rules"`, confidence from the recipe) and added to the proposal set through `StitchStore.setProposals`. A cleanup that is no longer detected is listed as "not applied" (`no-longer-detected`) and never forced into the plan.
- Category cleanups store no variant map. Variants are detected again on the new data, so new spellings are covered. An edited canonical is replayed as the same `{ canonical }` edit the approval screen records.
- Edited (re-paired) matches are replayed on the current proposal that shares one endpoint, with the same `left~right` id convention the approval screen uses. If no such proposal exists the match is added as a normal approved match.
- The recipe's anchor and join keys are applied to the plan when the user clicks Confirm & stitch (`applyRecipeOverrides`), and JoinControls still lets them change both.
- Applying a recipe makes the mapped tables part of the stitch selection (same technique as the Autopsy Fix it handler) and does not open the approval screen or scroll.
- Table mapping: same name always maps (column problems are reported per item); otherwise a unique identical column schema maps; more than one candidate is `table-ambiguous`.
- Failed validation is shown in place (first 5 problems with JSON paths) and the apply path returns before touching the store or computing proposals.
- `RECIPE_MAX_VARIANTS` exists as a named constant for the schema's documented limits but is not used, because recipes carry no variant maps.
- The SQL script loads each source file as text (`read_csv(..., all_varchar = true, names = [...])`) and converts with simple per-type rules. Names come from the loaded schema because the original headers are not kept. The script is verified in a DuckDB test: it reproduces the app's month-one result exactly on the demo data.
- Next month's demo uses the file names `monsters.csv` and `experiments.csv` and the same headers, so table names map by name.
- Little Frank priority: magnifying glass, recipe scroll, chart sign, clipboard. The scroll shows while the stitched table is the same as when the recipe was applied, so a new stitch or Reset hides it.

## Tiny additive edits to existing files

- `src/core/stitching/match-scoring.ts`: `pairId` is now exported (no behavior change).
- `src/core/types.ts` and `src/db/duckdb-service.ts`: an optional `exportFileBytes` on `DuckDBService` and `DuckDBConnectionAdapter`. The service method always exists and throws a clear error when the connection cannot export. The browser connection implements it with `copyFileToBuffer` and `dropFile`.
- `src/core/chat/demo-loader.ts`: `DemoId` gains `"nextMonth"`. `src/core/chat/demo-loader.test.ts` got the extra provider entry so it type-checks.
- `src/components/TablePreview.tsx`: optional `renderActions` prop.
- `src/components/Specimen.tsx` and `.css`: optional `recipeApplied` prop and the scroll. Two tests added to `Specimen.smoke.test.tsx`.
- `src/App.tsx`: recipe state and handlers, the demo button, `RecipeRegion`, and the `renderActions` wiring.
- Nothing in `api/`, no existing spec or steering doc.

## Deviations

- **Parquet needs a one-time extension download.** In DuckDB-WASM 1.32 (engine 1.4.3) the Parquet extension is a loadable extension, not statically linked (`duckdb_extensions()` reports it as not installed, and `LOAD parquet` fails in the node-blocking bundle). In the browser, the first Parquet export is expected to fetch the extension from DuckDB's extension repository. No user data is sent, but this is a network request, which conflicts with the "no network" rule in `security.md` and Requirement 9.1. Mitigation: it only happens when the user clicks Parquet, and the export buttons show a hint saying so. If the fetch fails (offline), the user sees the error message in place and CSV and Excel still work. I could not verify the browser behavior in this run.
- Because of the same limit, there is no real-DuckDB Parquet test. Parquet is covered by a unit test of the generated `COPY` statement and the virtual file name through a fake service. CSV export is tested against real DuckDB.
- Requirement 5.2 says one `CREATE TABLE ... AS SELECT ... FROM read_csv(...)` per source table. The script instead uses a typed `CREATE TABLE` plus `INSERT ... SELECT ... FROM read_csv(...)` so the column types match the app's tables. Same intent.
- Requirement 6.5 expects month-two values the recipe did not see to be covered. They are: the species `Bog Hag` and its spellings are detected fresh. The pinned golden result shows the existing rule's behavior (for example it picks `BOG HAG` as the canonical form because of its frequency rule).

## Known issues

- Parquet export is untested in a browser (see above).
- The percent and currency conversions in the SQL script are simpler than the app's (percent values are not divided by 100). The script's header says so. The demo data has no such columns.
- An XLSX source is described in the script as a CSV placeholder with a comment, because DuckDB reads Excel through an extension.
- If a recipe is applied while the approval screen is already open, the proposals are replaced under the user. Their earlier decisions are discarded (the existing recompute behavior).
- The App-level handlers are not rendered under jsdom. The same logic is exercised through `applyRecipeText` with a real StitchStore and DuckDB.
- Lint reports warnings only (the existing `set-state-in-effect` pattern in `App.tsx`).

## Exact manual test steps

1. `npm run dev` and open the app.
2. Click "Load mismatched demo". Open "Stitch" and choose the two tables, then "Open stitching table" (the existing entry point).
3. On the approval screen click "Approve all high-confidence" and approve the cleanups (or each proposal), then "Confirm & stitch", then "Apply & stitch". The stitched result appears.
4. In the "Recipes" section click "Save recipe". A file `frankendata-recipe-<date>.json` downloads and "Saved ..." shows in place. Optionally click "Export SQL script" and the CSV and Excel buttons for the stitched result.
5. Click "Reset lab". Click "Load next month's files".
6. In "Recipes" click "Apply recipe" and choose the saved JSON. The page does not scroll. You see "N proposals pre-approved, M not applied" and a "Not applied" list if anything could not be mapped. Little Frank holds a scroll.
7. Click "Review in stitching table". The approval screen opens and scrolls into view, with the mapped proposals already approved.
8. Click "Confirm & stitch". The anchor and join keys from the recipe are preselected. Click "Apply & stitch". Expect a 12 row result (14 roster rows minus the 2 extra duplicates).
9. Try an invalid file (any other JSON or a text file). Expect a red list of problems and no change to the proposals.
10. In any table preview card click CSV, Excel or Parquet. Parquet may take a moment the first time and needs a connection for the one-time extension download.

## Verification

- `npm test`: 132 files, 854 tests passing (about 68 new).
- `npm run build`: passes. `npm run lint`: warnings only. `npm run check:api`: passes.
- Golden tests pin: month one stitches, the recipe contains no row values, the recipe applied to the same tables gives an identical result (Property 2), the SQL script run in DuckDB reproduces the result, and the month-two result (12 rows, 9 pre-approved, none not applied).

## Credits used

Roughly 230 of the 300 budget. This is an estimate, since I have no exact meter.
