# Requirements Document

## Introduction

FrankenData is a client-side, browser-only web application for the Kiroween 2026 hackathon (Frankenstein category). Feature 1 (`.kiro/specs/frankendata-file-intake`) loads messy CSV/XLSX files into typed, in-memory DuckDB-WASM tables. Feature 2 (`.kiro/specs/frankendata-ai-stitching`) proposes matches and cleanups, applies approved plans non-destructively, and can undo them. Feature 3 (`.kiro/specs/frankendata-chat-sql`) answers plain-English questions. Feature 4 (`.kiro/specs/frankendata-autopsy`) reports data quality and offers Fix it actions.

This specification covers Feature 5: **Recipes and export**. It lets the user take their work out of the lab and repeat it:

- **Export** any loaded table or stitched result as CSV, Excel (`.xlsx`), or Parquet. The full table is exported, not the preview.
- **Save recipe**: after a stitch is applied, download a small JSON "recipe" describing the stitch (the schemas of the source tables, the approved and edited matches, the approved cleanups, the join anchor and keys). A recipe never contains row values and never contains SQL.
- **Apply recipe**: upload a recipe JSON, map it onto the currently loaded tables, and show the mapped proposals pre-approved on the existing approval screen, with anything that could not be mapped listed as "not applied" with a reason. The user still reviews and clicks Confirm & stitch and Apply & stitch. A recipe never stitches on its own.
- **Export SQL script**: download a readable DuckDB SQL script that reproduces the approved cleanups and the join from the original files, for use outside the app.
- **Demo**: a "Load next month's files" button loads a second pair of mismatched files with the same messy patterns and different rows, so the full month-one to month-two recipe story can be shown.
- **Little Frank** holds a small recipe scroll when a recipe has been applied.

A recipe is untrusted input. Everything it says is validated against a strict, versioned schema before it is used. The feature adds no AI and no network call. Out of scope: storing recipes on a server, sharing links, scheduled runs.

## Glossary

- **FrankenData**: The client-side web application built for the Kiroween 2026 hackathon.
- **Recipe**: A JSON document (format `frankendata-recipe`, version 1) describing an applied stitch: source table schemas, approved and edited matches, approved cleanups, join anchor, and join keys.
- **RecipeSchema**: The versioned structure and limits a Recipe must satisfy.
- **RecipeValidator**: The framework-agnostic function that checks untrusted input against the RecipeSchema and returns either a typed Recipe or a list of errors, with no side effects.
- **RecipeBuilder**: The function that builds a Recipe from a `StitchPlan` and the source `LoadedTable`s.
- **RecipeMapper**: The function that maps a Recipe onto the currently loaded tables and the current ProposalSet, producing mapped decisions and a NotAppliedList.
- **NotAppliedList**: The list of Recipe items that could not be mapped, each with a stable reason code and a plain-text reason.
- **MappedProposal**: A match or cleaning proposal, taken from or built to match the existing proposal types, that the RecipeMapper pre-approves.
- **TableExporter**: The module that serializes a table to CSV, XLSX, or Parquet bytes.
- **SqlScriptBuilder**: The pure function that builds the exported SQL script text.
- **NextMonthDemo**: The bundled second pair of mismatched demo files.
- **ApprovalFlow**: The existing Feature 2 approval screen, join panel, apply path (`StitchController.applyPlan`), and undo.
- **StitchPlan**, **MatchProposal**, **CleaningProposal**, **ProposalSet**, **ApprovalDecision**: The existing Feature 2 types in `src/core/stitching/types.ts`.
- **LittleFrank**: The mascot component (`Specimen`).
- **LoadedTable**: A table loaded by Feature 1, defined in `src/core/types.ts`.
- **TestSuite**: The automated test suite, including `fast-check` property tests and DuckDB-backed golden tests.

## Named Constants

These constants SHALL be exposed as named values in `src/core/recipes/types.ts` so that tests and the UI reference them rather than hard-coding literals.

- **RECIPE_FORMAT = "frankendata-recipe"** - The required `format` field value.
- **RECIPE_VERSION = 1** - The only supported `version`.
- **RECIPE_MAX_BYTES = 262144** - The largest recipe file accepted (256 KiB).
- **RECIPE_MAX_TABLES = 20** - The most source tables a recipe may describe.
- **RECIPE_MAX_COLUMNS_PER_TABLE = 200** - The most columns one described table may have.
- **RECIPE_MAX_ITEMS = 500** - The most matches plus cleanings a recipe may carry.
- **RECIPE_MAX_NAME_LENGTH = 200** - The longest table or column name accepted.
- **RECIPE_MAX_VARIANTS = 200** - The most variant-map entries on one category cleanup.
- **RECIPE_MAX_VALUE_LENGTH = 200** - The longest variant or canonical string accepted.
- **EXPORT_MAX_ROWS = 1048575** - The most data rows an XLSX export writes (the sheet limit minus the header row). A larger table gets a clear message instead of a file.

## Requirements

### Requirement 1: Export a table as CSV, Excel, or Parquet

**User Story:** As a data analyst, I want to download any loaded table or stitched result in a common format, so that I can use my cleaned data elsewhere.

#### Acceptance Criteria

1. THE application SHALL offer an "Export" control with three actions, CSV, Excel (.xlsx), and Parquet, for every loaded table and for the stitched result table when one exists.
2. THE export SHALL contain the FULL table (every row and every column in column order), read from DuckDB, and SHALL NOT be limited to the 20-row preview.
3. THE CSV export SHALL be RFC 4180 compliant with a header row, CRLF line endings, and quoting of any field containing a comma, a double quote, a CR, or an LF. NULL cells SHALL be written as empty fields. DATE cells SHALL be written as ISO `YYYY-MM-DD`. Parsing the CSV back with the app's own CSV parser SHALL yield the same cell values as the exported table (NULL as empty).
4. THE Excel export SHALL write one sheet named from the table name, a header row of column names, and typed cells (numbers as numbers, booleans as booleans, dates as date cells, text as text, NULL as an empty cell).
5. THE Parquet export SHALL be produced by DuckDB itself, using `COPY ... TO` a virtual file in the DuckDB-WASM file system followed by reading the bytes out, and the virtual file SHALL be dropped afterwards.
6. THE exported file name SHALL be derived from the table name by keeping only `A-Za-z0-9_-`, replacing other runs of characters with `_`, trimming leading and trailing `_`, and falling back to `table` when nothing is left. The extension SHALL be `.csv`, `.xlsx`, or `.parquet`. The name SHALL never contain a path separator or a dot other than the extension dot.
7. THE table name used in any SQL for export SHALL be quoted with the existing `quoteIdent` helper, and the virtual file name SHALL be generated by the application (never taken from user text).
8. IF an export fails (for example a table is dropped meanwhile, or the table exceeds `EXPORT_MAX_ROWS` for XLSX), THEN THE application SHALL show a clear plain-text message next to the Export control and SHALL NOT crash, and no other table SHALL be affected.
9. WHILE an export is running, THE clicked action SHALL show a busy state and SHALL be disabled, and on success THE control SHALL show an in-place confirmation such as "Exported monsters.csv". The page SHALL NOT scroll.
10. THE export SHALL read the tables only and SHALL NOT modify any table.

### Requirement 2: Save recipe after a stitch

**User Story:** As a data analyst, I want to save the choices I made in a stitch, so that I can repeat them on next month's files without redoing the review.

#### Acceptance Criteria

1. WHILE a stitched result exists, THE application SHALL offer a "Save recipe" button next to the stitched result. No recipe SHALL be offered before a stitch is applied or after it is undone.
2. THE saved Recipe SHALL be a JSON document with these top-level fields and no others: `format`, `version`, `createdAt`, `tables`, `matches`, `cleanings`, `join`.
3. `format` SHALL be `RECIPE_FORMAT` and `version` SHALL be `RECIPE_VERSION`. `createdAt` SHALL be an ISO 8601 UTC timestamp.
4. `tables` SHALL describe each source table that took part in the applied stitch by `name` and `columns` (each column a `name` and a `type` of `number`, `boolean`, `date`, or `string`). THE Recipe SHALL NOT contain any row value, sample value, file content, or source file name.
5. `matches` SHALL contain exactly the matches in the applied plan (approved and edited), each as a left and right column reference (`table`, `column`), a `confidence` number from 0 to 1, and a boolean `edited` that is true when the user re-paired the match. Rejected and undecided matches SHALL NOT be included.
6. `cleanings` SHALL contain exactly the cleanups in the applied plan, each with a `rule` (`whitespace`, `case`, `category`, `duplicate-rows`, or `outliers`), a `table`, a `column` for column-level rules, and for `category` an optional `canonical` and `edited` flag. Rejected and undecided cleanups SHALL NOT be included. A `category` cleanup SHALL NOT carry its variant map (the variants are detected again on the new data).
7. `join` SHALL contain the `anchor` table name and `keys`, one entry per joined table pair, each naming the two tables and the left and right key column references of the approved match used as that pair's key.
8. THE downloaded file name SHALL be `frankendata-recipe-<yyyy-mm-dd>.json` built from the creation date.
9. THE saved Recipe SHALL pass the RecipeValidator. THE RecipeBuilder SHALL be deterministic apart from `createdAt`, which is an injectable input.
10. Clicking Save recipe SHALL show an in-place confirmation, SHALL NOT scroll the page, and SHALL NOT change any table.

### Requirement 3: Validate an uploaded recipe as untrusted input

**User Story:** As a user, I want a recipe file to be checked strictly, so that a bad or malicious file can never harm my data or run code.

#### Acceptance Criteria

1. THE RecipeValidator SHALL reject any input larger than `RECIPE_MAX_BYTES` before parsing it.
2. THE RecipeValidator SHALL parse with `JSON.parse` only, SHALL reject non-JSON text, and SHALL reject a top-level value that is not a plain object.
3. THE RecipeValidator SHALL reject unknown fields at every object level, missing required fields, wrong types, a `format` other than `RECIPE_FORMAT`, and a `version` other than `RECIPE_VERSION` (with a distinct message for a newer version).
4. THE RecipeValidator SHALL enforce the limits `RECIPE_MAX_TABLES`, `RECIPE_MAX_COLUMNS_PER_TABLE`, `RECIPE_MAX_ITEMS`, `RECIPE_MAX_NAME_LENGTH`, `RECIPE_MAX_VARIANTS`, and `RECIPE_MAX_VALUE_LENGTH`, and SHALL accept only the four column types.
5. THE RecipeValidator SHALL check cross references: every table named in `matches`, `cleanings`, and `join` is described in `tables`, and every column named is a column of that table. It SHALL reject duplicate table names and duplicate column names within a table.
6. THE RecipeValidator SHALL reject names that are the special object keys `__proto__`, `constructor`, and `prototype`, and SHALL build its result as fresh plain objects so that a hostile JSON document cannot pollute prototypes.
7. A Recipe SHALL NOT contain or be able to execute SQL. THE RecipeMapper and every later step SHALL build identifiers only through the existing `quoteIdent` helper, and no Recipe text SHALL ever be interpolated into SQL as anything other than a quoted identifier or a quoted string literal that comes from the existing proposal pipeline. No field of a Recipe is ever evaluated, and no Recipe text is rendered as markup (plain text only).
8. WHEN validation fails, THE application SHALL show a clear error in place that lists up to 5 problems with their JSON paths, SHALL NOT change any proposal, decision, plan, or table, and SHALL leave the approval flow exactly as it was.
9. THE RecipeValidator SHALL be total: for any input it returns a result and never throws.

### Requirement 4: Apply a recipe to the loaded tables

**User Story:** As a data analyst, I want to apply a saved recipe to next month's files, so that the same stitch and cleanups are proposed and pre-approved, while I still review the result.

#### Acceptance Criteria

1. THE application SHALL offer an "Apply recipe" control that accepts one `.json` file by file picker or by drop on the control. It SHALL be available whenever at least one table is loaded.
2. THE RecipeMapper SHALL map each Recipe table onto a loaded table in this order: (a) a loaded table with the same name whose columns satisfy the column check below; (b) otherwise a loaded table with a different name whose column names and types equal the Recipe table's column names and types as sets, if exactly one such table exists and it is not already mapped. A Recipe table with no mapped table SHALL produce a NotAppliedList entry per dependent item with reason code `table-not-found`; two or more candidates in step (b) SHALL produce `table-ambiguous`.
3. THE column check SHALL map a Recipe column to the same-named column of the mapped table. A missing column SHALL produce `column-missing`. A column whose current type differs from the Recipe type SHALL produce `type-changed` for the dependent item.
4. THE RecipeMapper SHALL compare each Recipe match, after mapping, with the current ProposalSet by its existing proposal id. IF the current ProposalSet contains it, THE MappedProposal SHALL be that existing proposal with decision `approved`. IF it does not, THE RecipeMapper SHALL build a new `MatchProposal` of the existing type (confidence from the Recipe, source `rules`, reason "From recipe", zeroed components) and add it to the ProposalSet with decision `approved`, or `edited` when the Recipe marks it edited and it differs from the proposal detected for the same left column.
5. THE RecipeMapper SHALL map each Recipe cleaning to the existing proposal with the same rule, table, and column in the current ProposalSet and approve it. A `category` cleanup SHALL use the variant map detected in the current data (so new variants are covered) and, when the Recipe marks the canonical as edited and its canonical differs from the detected one, SHALL be recorded as an `edited` decision with that canonical. A cleanup whose finding is no longer detected in the current data SHALL be listed with reason code `no-longer-detected`; it SHALL NOT be forced into the plan.
6. THE RecipeMapper SHALL map the join anchor and keys: an anchor naming a mapped table becomes the proposed anchor, and a key whose two mapped tables and columns match an approved match becomes that pair's key. Items that cannot be mapped SHALL be listed with reasons `anchor-unmapped` or `key-unmapped`, and the default anchor and keys then apply.
7. WHEN a Recipe is applied, THE application SHALL recompute proposals through the existing StitchController, add the MappedProposals, record the decisions in the existing StitchStore, and show the existing approval screen with those proposals pre-approved. IF the screen is not shown, THE application SHALL NOT open it by itself; it SHALL show an in-place summary ("N proposals pre-approved, M not applied") with an explicit "Review in stitching table" button, and the page SHALL NOT scroll. Clicking that button SHALL open the approval screen in the same way the existing flow does.
8. THE NotAppliedList SHALL be shown on or beside the approval screen as a clearly labeled list, one row per item, each with a plain-text description of the item and its reason. Nothing SHALL be dropped silently: every Recipe match, cleanup, anchor, and key SHALL end up either mapped or in the NotAppliedList.
9. A Recipe SHALL NEVER stitch on its own. Confirm & stitch and Apply & stitch SHALL remain explicit user actions, and the user SHALL be able to change, reject, or add to any pre-approved proposal.
10. THE RecipeMapper SHALL NOT call DuckDB and SHALL NOT change a table. Applying a Recipe SHALL NOT change the stitching, cleaning, or apply logic.
11. WHERE the Recipe was saved from a stitch of tables and is applied to the same tables, the plan assembled from the pre-approved proposals SHALL be equivalent to the saved plan (same approved matches, same approved cleanings, same anchor and keys), and applying it SHALL yield an identical stitched result.
12. A later Recipe application SHALL replace the previous one's decisions, and SHALL show the new NotAppliedList.

### Requirement 5: Export a SQL script

**User Story:** As an analyst who wants to run the work outside the app, I want a readable DuckDB SQL script of the cleanups and the join, so that I can reproduce the result myself.

#### Acceptance Criteria

1. WHILE a stitched result exists, THE application SHALL offer an "Export SQL script" button that downloads `frankendata-stitch-<yyyy-mm-dd>.sql`.
2. THE script SHALL be built from the applied `StitchPlan` and the source `LoadedTable`s by a pure function and SHALL contain, in order: a header comment with the creation date and a note that the script was generated by FrankenData; one `CREATE TABLE ... AS SELECT ... FROM read_csv(...)` statement per source table that loads the original file from a clearly marked placeholder path; one cleaned-copy statement per table with approved cleanups, using the same expressions as the app's cleaned copies; and one `CREATE TABLE ... AS SELECT ... LEFT JOIN ...` statement for the result.
3. FILE PATHS SHALL be placeholders of the form `'/path/to/<source file name>'`, shown with a comment telling the user to replace them. THE script SHALL NOT contain any row value from the data. Variant maps and canonical values from approved category cleanups, which come from the cleanup proposals, SHALL appear as quoted string literals (they are part of the approved cleanup).
4. EVERY identifier in the script (tables, columns, aliases) SHALL be quoted with `quoteIdent`, and every string literal SHALL be quoted with `quoteString`. An adversarial name (containing quotes, semicolons, comments, newlines, or SQL keywords) SHALL stay inside its quoted identifier. Comment text derived from names SHALL be reduced to a single line with no comment terminator and no newline.
5. THE script SHALL reproduce the same cleaned copies and the same join as the app, by reusing the existing pure SQL builders `buildCleanedCopySql` and `buildJoinChainSql` rather than a second implementation. THE script SHALL use a fixed apply counter so its table names are stable.
6. THE script SHALL be plain text (UTF-8) and SHALL end with a newline. Clicking the button SHALL show an in-place confirmation and SHALL NOT scroll the page.
7. THE SQL script is for use outside the app. It SHALL NOT be sent to any server and SHALL NOT be run by the app.

### Requirement 6: "Load next month's files" demo

**User Story:** As a judge or first-time user, I want to see the whole recipe story with bundled data, so that I can try save, reset, load, and apply in a minute.

#### Acceptance Criteria

1. THE application SHALL offer a "Load next month's files" demo button next to the existing demo buttons.
2. THE NextMonthDemo SHALL load two bundled CSV files named `monsters.csv` and `experiments.csv`, with the same headers and the same messy patterns as the mismatched demo (inconsistent species spelling, casing, and whitespace; exact duplicate rows; a boolean column that must not match), and DIFFERENT rows: new creature names, new duplicates, and new casing variants.
3. THE NextMonthDemo SHALL be routed through the same intake pipeline as every other file and SHALL work offline, with no network access.
4. THE button SHALL follow the existing idempotent demo pattern: loading the same demo twice is a no-op until the lab is reset, and it SHALL show the existing "Already loaded" state.
5. WHEN the user stitches month one, saves a recipe, resets the lab, loads next month's files, and applies the recipe, THE application SHALL show a pre-approved stitch that, once confirmed and applied, produces the month-two stitched result pinned by the golden test. WHERE month-two data has new values the recipe did not see (new creature names, new casing variants), THE detected variants SHALL be covered because category cleanups are detected again.

### Requirement 7: Little Frank holds a recipe scroll

**User Story:** As a user, I want Little Frank to react when a recipe is applied, so that the feature feels part of the lab.

#### Acceptance Criteria

1. WHEN a Recipe has been applied (decisions recorded), THE LittleFrank SHALL hold a small recipe scroll, controlled by an optional `recipeApplied` prop passed through the existing `SpecimenRegion` props pattern. The prop SHALL default to false so existing renders are unchanged.
2. THE scroll SHALL use the same hand as the other held items. Its priority SHALL be: magnifying glass, then recipe scroll, then chart sign, then clipboard.
3. THE scroll SHALL be hidden when the lab is reset or when a new stitch is applied. IT SHALL be decorative (`aria-hidden`), SHALL NOT animate under `prefers-reduced-motion`, and SHALL NOT change any application state.

### Requirement 8: Feedback and navigation

**User Story:** As a user, I want clear feedback in place and no surprise scrolling, so that I stay oriented.

#### Acceptance Criteria

1. EVERY action in this feature (export, save recipe, apply recipe, export SQL) SHALL give feedback in place through a polite live region and a visible message near the control.
2. NO action in this feature SHALL scroll the page or move keyboard focus away from the control that was used, except an explicit "Review in stitching table" button, which opens the approval screen and scrolls to it (instantly under `prefers-reduced-motion`).
3. All controls SHALL be real buttons or labelled inputs, keyboard operable, with visible focus.

### Requirement 9: Privacy, safety, and non-interference

**User Story:** As a user, I want recipes and exports to keep my data private and to leave the rest of the lab alone.

#### Acceptance Criteria

1. THE feature SHALL make no network call. All parsing, validation, export, and script building SHALL happen in the browser.
2. A Recipe and an exported SQL script SHALL contain no row values (see Requirements 2.4 and 5.3).
3. THE feature SHALL NOT change the behavior of intake, stitching, cleaning, apply, Autopsy, Ask the Lab, or the SQL validator. It SHALL reuse them only through their public functions. Any tiny additive export SHALL be listed in `NOTES.md`.
4. THE feature SHALL add no runtime dependency.
5. THE exports and the SQL script builder SHALL NOT run through the Ask the Lab SQL validator because they are not model-written; every statement they issue SHALL be built from `quoteIdent`, `quoteString`, and application-generated names only.

### Requirement 10: Correctness properties for property-based tests

**User Story:** As a developer, I want the safety and equivalence properties checked by property-based tests, so that regressions are caught automatically.

#### Acceptance Criteria

1. **Property 1 (round trip)**: FOR ANY valid StitchPlan and source tables, building a Recipe, serializing it to JSON, validating it, and mapping it onto the same tables and the same ProposalSet SHALL yield a plan equivalent to the original (same approved match pairs, same approved cleanings by rule, table, and column, same anchor, same keys).
2. **Property 2 (same result)**: FOR the mismatched demo tables, applying a Recipe saved from a stitch to the same tables SHALL produce a stitched result table identical (columns and rows) to the original stitched result.
3. **Property 3 (hostile recipes)**: FOR ANY input (arbitrary JSON, arbitrary strings, mutated valid recipes, hostile names), THE RecipeValidator SHALL return a result without throwing, and a rejected Recipe SHALL cause no change to the StitchStore, the intake store, or any DuckDB table.
4. **Property 4 (CSV round trip)**: FOR ANY table of cell values, the CSV export parsed by the app's CSV parser SHALL return the same values (NULL as empty).
5. **Property 5 (SQL script quoting)**: FOR ANY table and column names, including adversarial ones, every identifier in the SQL script SHALL be quoted, and the script SHALL contain no statement boundary created by a name. Specifically, splitting the script with a quote-aware tokenizer SHALL find exactly the statements the builder emitted.
6. **Property 6 (safe file names)**: FOR ANY table name, the derived export file name SHALL match `^[A-Za-z0-9_-]+\.(csv|xlsx|parquet)$`.
7. EACH property test SHALL reference its design property by tag in its header comment (**Feature: frankendata-recipes, Property {n}: {title}**).
