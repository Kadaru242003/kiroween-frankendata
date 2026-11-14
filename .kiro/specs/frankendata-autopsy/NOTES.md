# Autopsy: run notes

## Summary

Feature 4, "The Autopsy", adds a per-table data quality report. An "Autopsy" button on each table preview opens a case file panel with a health score (0 to 100), per-column findings (nulls, constants, whitespace, case and category variants, outliers) and table-level duplicate rows. The report can be downloaded as Markdown or JSON. A "Fix it" button hands a finding to the existing cleanup approval screen. Little Frank holds a magnifying glass while the panel is open.

The engine lives in `src/core/autopsy/` and is framework-agnostic. The UI lives in `src/components/autopsy/`. No tiny exports were added to existing core modules. Reuse is through existing public functions only (`cleanTables`, `createSampleReader`, `quoteIdent`, `toDisplayValue`). No changes to `api/`, existing specs or existing steering docs. No new runtime dependencies.

## Decisions made without asking

- Fix it reuses existing proposal ids: `clean:whitespace:T.col`, `clean:case:T.col`, `clean:category:T.col`, `clean:duplicate-rows:T`. Outlier findings have no fix.
- Fix it is offered for loaded tables only. Stitched results (`stitch_n_result`) are read-only in the report, and the panel says so.
- `App.tsx` gets a `cleanupOnly` flag so the approval screen can open with a single table. Render condition is `(canStitch || cleanupOnly) && stitchOpen`.
- `handleFixIt`: re-select the table, compute proposals if the id is missing, mark the decision approved, open the approval screen.
- The duplicate Fix it label reads "Remove duplicate rows (ignoring extra whitespace)", because the existing rule normalizes whitespace.
- Health score is 100 minus capped deductions: duplicates up to 20, nulls up to 25, all-null columns up to 15, constant up to 6, whitespace up to 10, variants up to 15, outliers up to 10. The demo monsters table scores 81.
- Outliers are reported only when IQR > 0, with 1.5 x IQR fences.
- SQL safety: identifiers through `quoteIdent`, generated aliases, only finite numbers interpolated.
- The string variants query groups raw values first, then normalizes each distinct value. Grouping on a `regexp_replace` expression crashes the DuckDB-WASM MVP bundle. The rewrite is also about 10x faster.
- The engine returns `too-large` before any query when the row count exceeds 1,000,000.
- Stage C samples STRING columns only, then passes the full schema to `cleanTables`.
- Little Frank's magnifying glass takes priority over the chart sign and clipboard, which share a hand.

## Deviations from requirements

- Requirement 9.5 was reworded: after Fix it, result rows equal the original minus the proposal's own duplicate count, since the report's count is exact and the rule's is whitespace-normalized.
- Fixing stitched results is not supported (see Requirement 5.5).
- Category variant count comes from the existing rule's bounded sample, an exception to "full table" in 2.8 and 2.10.
- `conversionFailures` is absent from `ColumnFinding`, because intake records none (2.6).

## Known issues

- Lint reports warnings only (`set-state-in-effect` in `CaseFilePanel.tsx` and `App.tsx`, `only-export-components` in `CaseFilePanel.tsx` and `Specimen.tsx`). They match existing patterns.
- The existing duplicate rule costs about 500 ms on 100k x 20 and sets the performance floor. Total is about 968 ms.
- Fix it recomputes proposals when the id is missing, which resets existing approval decisions.
- The App-level `handleFixIt` flow is not rendered under jsdom. It is verified at the DuckDB level by the handoff integration test.
- The hostile-identifier property test discards a case if `createTable` itself fails.
- Earlier Little Frank UI items remain undone: table rows sewing in, and a flask favicon. `public/favicon.svg` is still the default Vite icon.

## Exact manual test steps for the demo data

1. `npm run dev` and open the app.
2. Click "Load mismatched demo".
3. Click "Autopsy of monsters". Expect score 81, 2 duplicate rows, and a Species warning with whitespace 1 and case groups 2.
4. Click "Fix it" on the duplicate rows or on Species. The approval screen opens with that proposal approved.
5. Click "Confirm & stitch", then "Apply & stitch" (result has 12 rows), then "Undo stitch".
6. Download Markdown and JSON from the panel.
7. Confirm Little Frank holds the magnifying glass while the panel is open.
8. Open Autopsy on a stitched result. It shows read-only with no Fix it.

## Credits used

About 150 to 170 of the 250 budget.
