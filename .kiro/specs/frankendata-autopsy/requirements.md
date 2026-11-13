# Requirements Document

## Introduction

FrankenData is a client-side, browser-only web application for the Kiroween 2026 hackathon (Frankenstein category). Feature 1 (`.kiro/specs/frankendata-file-intake`) loads messy CSV/XLSX files into typed, in-memory DuckDB-WASM tables. Feature 2 (`.kiro/specs/frankendata-ai-stitching`) proposes matches and cleanups, applies approved plans non-destructively, and can undo them. Feature 3 (`.kiro/specs/frankendata-chat-sql`) answers plain-English questions over the loaded tables.

This specification covers Feature 4: **The Autopsy**. For any loaded table or stitched result, the user can open a data quality report themed as a lab autopsy "case file". The report is computed entirely in the browser with aggregate DuckDB SQL and the existing deterministic cleaning-rule detection. It involves no AI and makes no network call, so it works fully with `VITE_AI_ENABLED` off.

The report shows per-column findings (type, nulls, distinct counts, top values, min, max, mean, median, whitespace and casing variants, numeric outliers), table-level findings (exact duplicate rows, candidate keys, all-null columns, constant columns), a transparent 0 to 100 health score, and a per-column status of healthy, warning, or critical. For findings the existing cleaning rules already handle, a "Fix it" action feeds the existing approval flow with an existing `CleaningProposal`, so every change stays non-destructive, reviewable, and undoable. The report can be exported as Markdown and JSON. Little Frank, the lab mascot, holds a magnifying glass while a report is open.

An autopsy never modifies any table. Out of scope: any AI summary, editing data from the report, cross-table relationship analysis, saved or scheduled reports.

## Glossary

- **FrankenData**: The client-side web application built for the Kiroween 2026 hackathon.
- **Autopsy**: The subsystem added by this feature: the engine, health score, Fix it mapping, report panel, and exports.
- **AutopsyEngine**: The framework-agnostic core module under `src/core/autopsy/` that runs aggregate SQL through `DuckDBService.query` and assembles an AutopsyReport.
- **AutopsyTarget**: A table the user can open an Autopsy on: an original LoadedTable or a stitched result table (`stitch_<n>_result`). Described by its table name, column schema, and row count.
- **AutopsyReport**: The complete, JSON-serializable result for one AutopsyTarget: table-level findings, a ColumnFinding per column, a HealthBreakdown, and the Fix it actions.
- **ColumnFinding**: The findings for one column (type, counts, statistics, variants, outliers, status).
- **TableFinding**: The findings about the table as a whole (duplicate rows, candidate keys, all-null columns, constant columns).
- **HealthScore**: An integer from 0 to 100 computed from a HealthBreakdown.
- **HealthBreakdown**: The ordered list of deductions that produced the HealthScore, each with a code, a plain-text reason, and a number of points.
- **ColumnStatus**: One of `healthy`, `warning`, or `critical`, assigned per column by defined thresholds.
- **FixAction**: A "Fix it" action that maps one finding to one existing `CleaningProposal` (whitespace-case, category-standardize, or duplicate-rows) produced by the existing cleaning rules.
- **ApprovalFlow**: The existing Feature 2 approval screen, join panel, apply path (`StitchController.applyPlan`), and undo.
- **CaseFilePanel**: The React panel that renders an AutopsyReport.
- **LittleFrank**: The mascot component (`Specimen`) that reacts to application state.
- **LoadedTable**: A table loaded by Feature 1, defined in `src/core/types.ts`.
- **TestSuite**: The automated test suite, including `fast-check` property tests and DuckDB-backed golden tests.

## Named Constants

These constants SHALL be exposed as named values in `src/core/autopsy/types.ts` so that tests and the UI reference them rather than hard-coding literals.

- **AUTOPSY_MAX_ROWS = 1000000** - The largest row count an Autopsy will analyze. Larger tables get a clear cap message and no findings.
- **AUTOPSY_TOP_VALUES = 5** - The number of most frequent values reported per low-cardinality column.
- **AUTOPSY_LOW_CARDINALITY_MAX = 50** - A column is low-cardinality when its non-null distinct count is at most this value.
- **AUTOPSY_OUTLIER_EXAMPLES = 5** - The maximum number of outlier example values reported per column.
- **AUTOPSY_IQR_FACTOR = 1.5** - The multiplier of the interquartile range used for outlier fences.
- **AUTOPSY_NULL_WARN_PCT = 5** - A column with a null percent at or above this value is at least `warning`.
- **AUTOPSY_NULL_CRIT_PCT = 50** - A column with a null percent at or above this value is `critical`.
- **AUTOPSY_OUTLIER_CRIT_PCT = 10** - A numeric column whose outliers are at least this percent of its non-null values is `critical`.
- **AUTOPSY_TARGET_MS = 2000** - The performance target for 100,000 rows by 20 columns.

## Requirements

### Requirement 1: Entry Point and Case File Panel

**User Story:** As a data analyst, I want an "Autopsy" action on every table preview, so that I can inspect the quality of any loaded table or stitched result in one click.

#### Acceptance Criteria

1. THE TablePreview card for each LoadedTable and each stitched result SHALL display an "Autopsy" button.
2. WHEN the user activates the "Autopsy" button, THE FrankenData SHALL open the CaseFilePanel for that AutopsyTarget and begin computing its AutopsyReport.
3. THE CaseFilePanel SHALL provide a close control, and WHEN the user closes it, THE FrankenData SHALL remove the panel and leave every table unchanged.
4. WHILE only one CaseFilePanel can be open, WHEN the user opens an Autopsy on a different table, THE FrankenData SHALL replace the open panel with the new one.
5. THE Autopsy SHALL work when `VITE_AI_ENABLED` is off and SHALL make no network request under any configuration.
6. WHEN the AutopsyTarget is removed from the lab (for example by Reset lab or an undone stitch), THE FrankenData SHALL close its CaseFilePanel.

### Requirement 2: Per-Column Findings

**User Story:** As a data analyst, I want detailed findings for every column, so that I can see exactly where my data is messy.

#### Acceptance Criteria

1. THE AutopsyEngine SHALL report, for every column, the inferred ColumnType, the table row count, the null count, and the null percent.
2. THE AutopsyEngine SHALL report, for every column, the count of distinct non-null values.
3. WHEN a column has at most AUTOPSY_LOW_CARDINALITY_MAX distinct non-null values, THE AutopsyEngine SHALL report its AUTOPSY_TOP_VALUES most frequent values with their counts, ordered by count descending and then by value ascending.
4. WHEN a column is of ColumnType number, THE AutopsyEngine SHALL report its minimum, maximum, mean, and median.
5. WHEN a column is of ColumnType date, THE AutopsyEngine SHALL report its minimum, maximum, mean, and median as `YYYY-MM-DD` dates.
6. THE AutopsyEngine SHALL report a conversion-failure count for a column only when the intake pipeline has recorded one for that column, and SHALL otherwise omit the field and SHALL NOT estimate or invent it.
7. WHEN a column is of ColumnType string, THE AutopsyEngine SHALL report the number of rows whose value differs from its whitespace-normalized form (trimmed, with internal whitespace runs collapsed), and the number of groups of values that differ only by letter case.
8. WHEN a column is of ColumnType string, THE AutopsyEngine SHALL report the number of category variants found by the existing category-standardize cleaning rule for that column, computed by that rule over its bounded sample of distinct values (the rule's own limit, MAX_SAMPLE_VALUES_PER_COLUMN).
9. WHEN a column is of ColumnType number AND its interquartile range is greater than zero, THE AutopsyEngine SHALL report the count of values outside the fences `Q1 - AUTOPSY_IQR_FACTOR x IQR` and `Q3 + AUTOPSY_IQR_FACTOR x IQR`, and up to AUTOPSY_OUTLIER_EXAMPLES example values, choosing those farthest from the median.
10. THE AutopsyEngine SHALL compute every finding from the full table, not from a sample, with the single documented exception of the category variant count in criterion 8, which is the existing rule's own bounded-sample result.

### Requirement 3: Table-Level Findings

**User Story:** As a data analyst, I want findings about the table as a whole, so that I can spot duplicates and structural problems.

#### Acceptance Criteria

1. THE AutopsyEngine SHALL report the number of exact duplicate rows, defined as the row count minus the count of distinct whole rows, treating NULLs as equal.
2. THE AutopsyEngine SHALL list the candidate key columns, defined as columns with no nulls whose distinct count equals the row count, for tables with at least one row.
3. THE AutopsyEngine SHALL list the all-null columns, defined as columns with zero non-null values in a table with at least one row.
4. THE AutopsyEngine SHALL list the constant columns, defined as columns with exactly one distinct non-null value in a table with at least two rows.
5. WHEN a table has zero rows, THE AutopsyEngine SHALL report zero for every count and SHALL NOT report candidate keys, all-null columns, or constant columns.

### Requirement 4: Health Score and Column Status

**User Story:** As a data analyst, I want a single health score with a clear explanation, so that I can judge a table at a glance and understand why.

#### Acceptance Criteria

1. THE AutopsyEngine SHALL compute a HealthScore as an integer between 0 and 100 inclusive for every AutopsyReport.
2. THE AutopsyEngine SHALL start from 100 and subtract a bounded number of points for each problem category: duplicate rows, null density, all-null columns, constant columns, whitespace problems, casing and category variants, and numeric outliers, with the exact formulas defined in the design.
3. THE AutopsyReport SHALL include the HealthBreakdown listing every non-zero deduction with its code, plain-text reason, and points, such that the points sum to 100 minus the HealthScore unless the score was clamped at 0.
4. THE AutopsyEngine SHALL assign each column a ColumnStatus: `critical` WHEN its null percent is at least AUTOPSY_NULL_CRIT_PCT or it is all-null or its outliers are at least AUTOPSY_OUTLIER_CRIT_PCT of its non-null values; otherwise `warning` WHEN its null percent is at least AUTOPSY_NULL_WARN_PCT or it is constant or it has whitespace, casing, or category variants or any outliers; otherwise `healthy`.
5. THE CaseFilePanel SHALL display the HealthScore, the HealthBreakdown, and each column's ColumnStatus using both text and color, so that status is never conveyed by color alone.

### Requirement 5: Fix It Actions

**User Story:** As a data analyst, I want to fix findings the lab already knows how to fix, so that cleanup goes through the same safe, reviewable flow.

#### Acceptance Criteria

1. FOR each finding of whitespace variants, casing variants, category variants, or duplicate rows on a LoadedTable, THE Autopsy SHALL offer a "Fix it" action only WHEN the existing cleaning rules produce a matching `CleaningProposal` for that table.
2. THE Autopsy SHALL obtain every FixAction's proposal by calling the existing cleaning rules through their public functions, and SHALL NOT define any new proposal kind or apply path.
3. WHEN the user activates "Fix it", THE FrankenData SHALL place that proposal in the existing ApprovalFlow with its decision set to approved, open the approval screen, and apply nothing until the user confirms and applies through the existing controls.
4. THE FrankenData SHALL NOT modify any table directly from the CaseFilePanel; changes occur only through the ApprovalFlow's cleaned copies, and the existing Undo stitch SHALL reverse them.
5. THE Autopsy SHALL NOT offer "Fix it" for a stitched result table, because the existing ApprovalFlow operates on loaded tables only, and THE CaseFilePanel SHALL state this when viewing a stitched result.
6. WHEN only one table is loaded, "Fix it" SHALL still open the approval screen in a cleanup-only mode that does not require a second table.

### Requirement 6: Export

**User Story:** As a data analyst, I want to download the report, so that I can share or archive it.

#### Acceptance Criteria

1. THE CaseFilePanel SHALL provide a "Download Markdown" action that downloads the AutopsyReport as a Markdown document.
2. THE CaseFilePanel SHALL provide a "Download JSON" action that downloads the AutopsyReport as JSON that parses back to an equivalent report.
3. THE Markdown and JSON exports SHALL contain the same findings, the HealthScore, and the HealthBreakdown, and SHALL contain no executable markup.
4. THE exports SHALL be generated entirely in the browser with no network request.
5. THE exports SHALL escape Markdown-significant characters in table, column, and value text so that data cannot alter the report structure.

### Requirement 7: Performance and Safety

**User Story:** As a security-conscious developer, I want the autopsy to be fast and provably read-only, so that it can never harm my data or the app.

#### Acceptance Criteria

1. THE AutopsyEngine SHALL issue only read-only `SELECT` statements and SHALL NOT create, alter, insert into, update, or drop any table, view, or temporary object.
2. THE AutopsyEngine SHALL quote every table and column identifier with the shared `quoteIdent` helper and SHALL NOT concatenate any data value into SQL text other than finite numbers formatted from computed statistics.
3. WHEN a table or column name contains quotes, semicolons, comment markers, or SQL keywords, THE AutopsyEngine SHALL treat it as an inert identifier and SHALL NOT execute any injected statement.
4. THE AutopsyEngine SHALL complete an AutopsyReport for a table of 100,000 rows by 20 columns within AUTOPSY_TARGET_MS on a typical laptop.
5. THE AutopsyEngine SHALL report progress incrementally (table basics first, then each column's detailed findings), and THE CaseFilePanel SHALL render partial results as they arrive.
6. WHEN a table has more than AUTOPSY_MAX_ROWS rows, THE AutopsyEngine SHALL return a report marked as too large with a clear message and no findings, and THE CaseFilePanel SHALL display that message.
7. WHEN any query fails, THE AutopsyEngine SHALL report a friendly error for that report and SHALL NOT throw to the caller or crash the application.
8. THE AutopsyEngine SHALL be framework-agnostic, with no dependency on React or the DOM, per `.kiro/steering/structure.md`.

### Requirement 8: User Interface

**User Story:** As a participant, I want the report to look like a lab case file and be accessible, so that it is on-theme and usable by everyone.

#### Acceptance Criteria

1. THE CaseFilePanel SHALL apply the existing lab theme tokens, present itself as a case file with a title, the table name, and a stamped health score, and render body text with a contrast ratio of at least 4.5:1.
2. THE CaseFilePanel SHALL be a labeled region reachable and operable by keyboard, with a visible focus ring on every control, and SHALL announce completion of the report to screen readers through a polite live region.
3. THE CaseFilePanel SHALL render every table name, column name, value, and reason as plain text, never as markup.
4. WHEN the user prefers reduced motion, THE CaseFilePanel SHALL show no animation.
5. WHILE a CaseFilePanel is open, THE LittleFrank mascot SHALL show a magnifying glass, driven by a read-only prop derived in the existing SpecimenRegion pattern, and SHALL return to its prior pose when the panel closes.
6. THE CaseFilePanel SHALL NOT obscure the table previews' own controls and SHALL NOT trap keyboard focus.

### Requirement 9: Correctness Properties for Property-Based Tests

**User Story:** As a developer, I want property-based tests for the safety and determinism invariants, so that the Autopsy is trustworthy across varied inputs.

#### Acceptance Criteria

1. THE TestSuite SHALL include a property-based test verifying that the HealthScore is an integer between 0 and 100 for arbitrary report inputs.
2. THE TestSuite SHALL include a property-based test verifying that for every column the null percent equals the null count divided by the row count (zero when the row count is zero).
3. THE TestSuite SHALL include a property-based test verifying that running the AutopsyEngine twice on the same table yields identical reports.
4. THE TestSuite SHALL include a property-based test verifying that running an Autopsy never changes any table's schema, row count, or contents.
5. THE TestSuite SHALL include a property-based test verifying that every FixAction proposal is accepted by the existing applier, leaves the original table unchanged, and produces a result whose row count equals the original minus the duplicates when a duplicate-rows proposal is applied.
6. THE TestSuite SHALL include a property-based test verifying that adversarial table and column names never cause an injected statement to execute.
7. THE TestSuite SHALL include a DuckDB golden test on the mismatched demo data that pins exact findings, including the monsters table's duplicate rows and its species casing variants.
8. THE TestSuite SHALL exercise the Autopsy only against local DuckDB and SHALL make no network call.

### Requirement 10: Scope Boundaries

**User Story:** As a developer, I want the scope bounded, so that the feature stays small and shippable.

#### Acceptance Criteria

1. THE Autopsy SHALL NOT include any AI-generated summary or call any proxy.
2. THE Autopsy SHALL NOT edit data from the report.
3. THE Autopsy SHALL NOT analyze relationships between tables.
4. THE Autopsy SHALL NOT save, persist, or schedule reports; refreshing the page discards them.
