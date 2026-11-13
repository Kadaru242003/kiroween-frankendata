# Design Document: FrankenData Autopsy

## Overview

This document describes the design of **Feature 4: The Autopsy**, a data quality report for any loaded table or stitched result. It is computed entirely in the browser with aggregate DuckDB SQL plus the existing deterministic cleaning rules. There is no AI and no network call. An autopsy never modifies a table. Findings that the existing cleaning rules can already fix are offered as "Fix it" actions that feed the existing approval flow, so every change stays reviewable, non-destructive, and undoable.

The design follows `.kiro/steering/structure.md`: a framework-agnostic core module under `src/core/autopsy/` that is unit- and property-tested without React, and React only at the edges under `src/components/autopsy/`.

## Architecture

```
TablePreview card  --"Autopsy" click-->  App (autopsy target state)
                                              |
                                              v
                                   CaseFilePanel (React, edge)
                                              |  runAutopsy(db, target, {onProgress})
                                              v
   src/core/autopsy/autopsy-engine.ts   (read-only SELECTs via DuckDBService.query)
        |-- autopsy-sql.ts      pure SQL builders (quoteIdent only)
        |-- health-score.ts     pure score + column status
        |-- fix-it.ts           SampleReader + cleanTables -> FixAction[]
        |-- report-export.ts    pure Markdown / JSON
        '-- types.ts            constants + report types

   Fix it:  FixAction.proposal  ->  StitchStore (proposals + decision "approved")
            -> existing ApprovalScreen -> JoinControls -> StitchController.applyPlan -> Undo stitch
```

### Module layout

`src/core/autopsy/` (framework-agnostic):

- `types.ts`: named constants (`AUTOPSY_*`), `AutopsyTarget`, `ColumnFinding`, `AutopsyReport`, `HealthDeduction`, `FixAction`.
- `autopsy-sql.ts`: pure builders for each query. Imports only `quoteIdent` from `src/core/stitching/sql-escape.ts`.
- `health-score.ts`: `computeHealth(parts)` and `columnStatus(finding)`.
- `autopsy-engine.ts`: `runAutopsy(db, target, options)`; orchestrates stages, never throws.
- `fix-it.ts`: `buildFixActions(db, target)` maps cleaning proposals to `FixAction`s.
- `report-export.ts`: `toMarkdown(report)` and `toJson(report)`.

`src/components/autopsy/`:

- `CaseFilePanel.tsx` and `.css`: the case-file report panel, export buttons, Fix it buttons.
- `download.ts`: the small Blob download helper (UI edge only).

Existing files touched by small, additive edits: `TablePreview.tsx` (optional `onAutopsy` prop and button), `Specimen.tsx` (optional `autopsyOpen` prop and magnifying glass), and `App.tsx` (autopsy target state, the Fix it handler, the cleanup-only mode, and the new region). No existing core behavior changes.

## Data model

```ts
export interface AutopsyTarget { tableName: string; schema: ColumnSchema[]; rowCount: number; }

export interface ColumnFinding {
  name: string; type: ColumnType;
  rows: number; nullCount: number; nullPct: number;      // nullPct = nullCount / rows * 100, 0 when rows = 0
  distinct: number;                                      // non-null distinct
  topValues?: { value: string; count: number }[];        // only when distinct <= LOW_CARDINALITY_MAX
  min?: number | string; max?: number | string;          // number: numbers; date: YYYY-MM-DD
  mean?: number | string; median?: number | string;
  whitespaceRows?: number; caseVariantGroups?: number;   // string columns
  categoryVariants?: number;                             // from the existing category rule
  outliers?: { count: number; lower: number; upper: number; examples: number[] };
  status: "healthy" | "warning" | "critical"; statusReasons: string[];
  // conversionFailures is intentionally absent: intake records none (Requirement 2.6).
}

export interface HealthDeduction { code: string; reason: string; points: number; }

export interface FixAction {
  proposalId: string; kind: CleaningKind; columnName?: string; label: string; proposal: CleaningProposal;
}

export interface AutopsyReport {
  version: 1; complete: boolean;
  status: "ok" | "too-large" | "error"; message?: string;
  tableName: string; rows: number; columnCount: number;
  columns: ColumnFinding[];
  duplicateRows: number; candidateKeys: string[]; allNullColumns: string[]; constantColumns: string[];
  health: { score: number; breakdown: HealthDeduction[] };
  fixes: FixAction[];
}
```

## SQL strategy

All identifiers go through `quoteIdent`. Column aliases are generated (`n`, `nn3`, `d3`, `mn3`, ...) and never derived from data. The only values interpolated into SQL are finite numbers formatted by `numLit(x)` from computed statistics (outlier fences and the median); `numLit` throws on a non-finite number and the engine catches it as a friendly error. Numeric results are normalized in TypeScript with the existing `toDisplayValue` (BigInt, DECIMAL, and Date safe).

**Stage A, one aggregate query for the whole table** (single pass):

```sql
SELECT COUNT(*) AS n,
       COUNT("c") AS nn0, COUNT(DISTINCT "c") AS d0,                       -- every column
       CAST(MIN("c") AS DOUBLE) AS mn1, CAST(MAX("c") AS DOUBLE) AS mx1,    -- numeric
       CAST(AVG("c") AS DOUBLE) AS av1,
       CAST(quantile_cont("c", 0.5) AS DOUBLE) AS md1,
       CAST(quantile_cont("c", 0.25) AS DOUBLE) AS q1_1,
       CAST(quantile_cont("c", 0.75) AS DOUBLE) AS q3_1,
       MIN("d") AS mn2, MAX("d") AS mx2,                                    -- date (raw, converted as dates)
       CAST(AVG(epoch("d")) AS DOUBLE) AS av2,                              -- date mean in epoch seconds
       CAST(quantile_cont(epoch("d"), 0.5) AS DOUBLE) AS md2                -- date median in epoch seconds
FROM "T"
```

Date epoch seconds are converted to `YYYY-MM-DD` in TypeScript (`floor(sec / 86400)` days since 1970, UTC).

**Table duplicates** (the same method as the existing duplicate rule):

```sql
SELECT COUNT(*) - (SELECT COUNT(*) FROM (SELECT DISTINCT * FROM "T")) AS dups FROM "T"
```

**Stage B, per column, sequential** so each column renders as soon as it finishes:

- Top values, when `distinct <= LOW_CARDINALITY_MAX` and `nn > 0`:
  `SELECT CAST("c" AS VARCHAR) AS v, COUNT(*) AS c FROM "T" WHERE "c" IS NOT NULL GROUP BY "c" ORDER BY c DESC, v ASC LIMIT 5` (the same tie-break as `SampleReader`).
- String whitespace rows and case variant groups, with `NORM(c) = regexp_replace(regexp_replace(c, '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g')`:
  ```sql
  SELECT
    (SELECT COUNT(*) FROM "T" WHERE "c" IS NOT NULL AND "c" <> NORM("c")) AS ws,
    (SELECT COUNT(*) FROM (SELECT 1 FROM "T" WHERE "c" IS NOT NULL
        GROUP BY LOWER(NORM("c")) HAVING COUNT(DISTINCT NORM("c")) > 1)) AS cg
  ```
- Numeric outliers, only when `iqr = q3 - q1 > 0`, with `lo = q1 - 1.5 x iqr`, `hi = q3 + 1.5 x iqr`:
  `SELECT COUNT(*) AS oc FROM "T" WHERE "c" < lo OR "c" > hi`, then
  `SELECT CAST("c" AS DOUBLE) AS v FROM "T" WHERE "c" < lo OR "c" > hi ORDER BY ABS("c" - median) DESC, "c" ASC LIMIT 5`.

**Stage C, existing cleaning rules**: `SampleReader.readTable(target)` then `cleanTables(db, [sample])`. The category variant count is `Object.keys(proposal.variantMap).length` for the `clean:category:<table>.<col>` proposal. These proposals are also the source of the FixActions (see below). Stage C failures are non-fatal: category variants are omitted and no fixes are offered.

**Derived findings** (pure, from stage A): candidate keys (`nn = n` and `d = n`, `n > 0`), all-null columns (`nn = 0`, `n > 0`), constant columns (`d = 1`, `n >= 2`).

**Row cap**: if the target's row count (confirmed by `n` from stage A) exceeds `AUTOPSY_MAX_ROWS`, the engine returns `status: "too-large"` with a message before any stage B work.

## Health score

Start at 100 and subtract the following (each is a `HealthDeduction` with a reason) only when its points are greater than zero:

| Code | Points |
|---|---|
| `duplicates` | `min(20, round(100 x duplicateRows / rows))` |
| `nulls` | `min(25, round(0.5 x meanNullPct))`, where `meanNullPct` is the mean of the column null percents |
| `all-null` | `min(15, 5 x allNullColumns)` |
| `constant` | `min(6, 2 x constantColumns)` |
| `whitespace` | `min(10, 2 x columnsWithWhitespace)` |
| `variants` | `min(15, 3 x columnsWithCaseOrCategoryVariants)` |
| `outliers` | `min(10, 2 x columnsWithOutliers)` |

`score = max(0, 100 - sum(points))`, an integer. The maximum total deduction is 101, so the clamp at 0 is reachable and the breakdown sums to `100 - score` except when clamped.

**Worked example** (the mismatched demo `monsters` table: 14 rows, 4 columns, the Gorzak row three times, `Species` with `swamp  wraith`, `Swamp Wraith`, `moth titan`, `Moth Titan`): duplicates `2 / 14 = 14.29%` gives 14 points; no nulls gives 0; one column has whitespace variants gives 2; one column has case variants (2 groups) gives 3; no constants, all-null, or numeric columns. Score `100 - 14 - 2 - 3 = 81`.

**Column status** follows Requirement 4.4 exactly using the `AUTOPSY_*` thresholds; `statusReasons` lists each condition that applied.

## Fix it mapping

`buildFixActions` is a thin mapping over the existing public functions: it reads the target's sample with `createSampleReader`, calls `cleanTables`, and keeps proposals of kind `whitespace-case`, `category-standardize`, or `duplicate-rows` for that table (outlier proposals are not offered; they add a column and are not a "fix"). Each becomes a `FixAction` whose `proposalId` is the existing id (`clean:whitespace:T.col`, `clean:case:T.col`, `clean:category:T.col`, `clean:duplicate-rows:T`). The panel attaches a column's actions to that column's card and the duplicate action to the table findings. No new proposal kind and no new apply path.

**Handing off to the approval flow** (App glue, `handleFixIt(tableName, proposalId)`):

1. Make sure the table is checked for stitching (remove it from the unchecked set and update the selection holder the controller reads).
2. Read the proposals in `StitchStore`. If they do not already contain `proposalId`, call the existing `StitchController.computeProposals()`; it recomputes the same ids because it uses the same functions. (This resets decisions, which is the existing behavior of recomputing.)
3. `store.setDecision({ proposalId, decision: "approved" })`.
4. Close the case file, set cleanup-only mode, and open the approval screen. The user confirms, applies with **Apply & stitch**, and can **Undo stitch**.

**Cleanup-only mode** exists because the existing stitch entry requires two tables. App keeps a `cleanupOnly` flag so the approval screen and join panel render with one table; nothing in the stitching core changes. The apply path already accepts a single-table plan with no matches (the join chain over one table is a plain select from the cleaned copy).

**Stitch results are read-only here**: the existing flow's `getTables()` returns loaded tables only, so a `stitch_<n>_result` cannot receive a cleaning plan. `runAutopsy` takes `allowFixes: false` for stitched results; the panel says so.

## UI layout

The panel is a labeled region (`aria-label="Autopsy case file"`) in the lab theme:

1. Header: "Case file" label, the table name, a stamp box showing `score / 100` and a verdict word, and Close.
2. Verdict and breakdown: each deduction as `-N reason`.
3. Table findings: duplicate rows (with its Fix it), candidate keys, all-null columns, constant columns.
4. Column cards (a table): name, type, a status badge with text (`HEALTHY`, `WARNING`, `CRITICAL`), nulls, distinct, min, max, mean, median; a `<details>` per column for top values, variants, and outliers, and the column's Fix it buttons.
5. Footer: Download Markdown, Download JSON (enabled when `complete`).
6. A polite live region announces "Autopsy complete" and any error.

Text only, never markup. Animation (a short stamp-in) is disabled under `prefers-reduced-motion`.

## Little Frank integration

`SpecimenProps` gains an optional `autopsyOpen?: boolean` (default false). When true, Little Frank holds a small magnifying glass (a ring and handle SVG on the right hand) and the `specimen--investigating` class is added; the chart sign and clipboard are suppressed while it shows, since they use the same hand. `SpecimenRegion` receives `autopsyOpen` from App state (read-only). No reaction transition is added.

## Error handling

`runAutopsy` wraps every stage in try/catch. A stage A or duplicates failure returns `status: "error"` with a friendly message and no throw. A stage B failure for one column records that column with only its stage A fields and a status reason "details unavailable"; the rest continue. Stage C failure omits variants and fixes. The panel shows the message with a Retry button. Progress callbacks that throw are ignored.

## Performance

Stage A is one pass. Stage B issues at most three small aggregate queries per column, and only for the applicable types. Stage C runs `SampleReader` (one grouped query per column) once. For 100,000 rows by 20 columns this is roughly 60 to 80 aggregate queries in total; a DuckDB-backed test measures it against `AUTOPSY_TARGET_MS`. Progress is emitted after stage A and after each column, so larger tables render progressively. Tables above `AUTOPSY_MAX_ROWS` are refused up front.

## Correctness properties and tests

| Property (Requirement 9) | Test file | Kind |
|---|---|---|
| 9.1 HealthScore is an integer in 0 to 100 | `health-score.range.property.test.ts` | pure property |
| 9.2 nullPct equals nullCount / rows | `autopsy-engine.null-percent.property.test.ts` | pure property over the report builder |
| 9.3 Same table gives identical reports | `autopsy-engine.determinism.property.test.ts` | DuckDB property |
| 9.4 Autopsy never changes schema, row count, or contents | `autopsy-engine.no-mutation.property.test.ts` | DuckDB property |
| 9.5 Every FixAction is accepted by the existing applier | `fix-it.applier.property.test.ts` | DuckDB property |
| 9.6 Adversarial identifiers never execute injected SQL | `autopsy-engine.identifiers.property.test.ts` | DuckDB property |
| 9.7 Golden findings on the mismatched demo | `autopsy-golden.duckdb.test.ts` | DuckDB golden |

Unit tests cover the SQL builders, `numLit`, the score formulas and thresholds, Markdown escaping, JSON round trip, the date epoch conversion, and the engine on small hand-made tables. UI smoke tests cover the panel (partial and complete render, too-large message, error and retry), the export buttons, the Fix it button, the TablePreview Autopsy button, and Little Frank's magnifying glass. A performance test measures 100,000 rows by 20 columns.
