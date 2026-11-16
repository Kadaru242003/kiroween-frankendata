# Bug sweep (branch `bug-sweep`)

Pre-submission bug hunt across the app, the MCP server and the API proxies. Each finding was proved with a throwaway probe (probes are deleted and not committed). Only confirmed Critical, High and Medium bugs were fixed, each with a test that failed before the fix.

Severity: Critical = data loss, security or privacy break, or a crash in the main flow. High = wrong results or a broken main-flow feature. Medium = edge case a judge could plausibly hit. Low = cosmetic or very unlikely.

## Findings

| id | area | severity | how to reproduce | expected vs actual | confirmed | status |
|----|------|----------|------------------|--------------------|-----------|--------|
| XLSX-DATE | Intake (XLSX) | High | Load an .xlsx with date cells while the machine time zone is Berlin, Kolkata, Tokyo or Auckland (`TZ=Europe/Berlin`, serial 46027) | Expected 2026-01-05. Actual 2026-01-04 (UTC getters). Times of day also shifted in Los Angeles. | yes | Fixed (`fix: XLSX date cells shift a day in non-UTC time zones`) |
| INTAKE-ZERO | Intake (CSV) | High | CSV with values `01234`, `0044123`, `007`, or a 20-digit id | Expected the text kept. Actual stored as 1234, 44123, 7; long ids lost precision (12345678901234567890 became 12345678901234567000). | yes | Fixed (`fix: keep leading-zero and 16+ digit identifiers as text`) |
| STITCH-MIXED-KEY | Stitching | High | Load `id,v / 1,a` and `id,w / x1,a`, Approve all suggestions, Apply | Expected a result. Actual: apply throws (DuckDB conversion error) and the UI shows nothing. | yes | Fixed (`fix: number-to-text join key no longer fails the whole stitch`) |
| CSV-FORMULA | Exports | High | Export or download CSV with a cell `=1+1`, `+cmd\|...`, `-2+3`, `@SUM(1)`, tab or CR first | Expected neutralised. Actual written raw (Ask CSV, table export, MCP export). | yes | Fixed (`fix: neutralise spreadsheet formulas in CSV exports`). Strings only; numbers and numeric text unchanged. |
| APPLY-SILENT | Stitching UI | Medium | Any apply failure in `handleApplyPlan` (`src/App.tsx`) | Expected a visible message. Actual swallowed silently. | no (the only reproducible trigger, STITCH-MIXED-KEY, is fixed) | Open. Needs a new UI element, so it is left for a decision. |
| CSV-BOM | Exports | Medium | Download CSV with accented text, open in Excel | Excel may show garbled text because the download has no BOM | no (depends on the Excel version) | Open. Would touch three download helpers; left for a decision. |
| ORPHAN-TABLES | Stitching | Low | Apply twice without undo leaves `stitch_N_*` tables | Not reachable from the UI (the Apply button is disabled once applied) | no | Open |
| STALE-AFTER-BACK | Stitching UI | Low | Stitch, Back to tables, reopen | Stitched result card hidden while the stitched table exists | yes | Open (Question below) |
| FOCUS-DROP | Accessibility | Low | Activate "Load business demo" or Apply by keyboard | Focus falls to body when the control is removed | yes | Open |
| H-SCROLL-768 | Layout | Low | 768px width | 19px horizontal scroll from `div.lab-intro__flash` | yes | Open |
| ASK-INPUT-RING | Accessibility | Low | Focus `.ask-panel__input` | No outline ring (the border changes) | yes | Open |
| COPY-NOCLIP | Ask the Lab | Low | `navigator.clipboard` undefined | SqlBlock still says "Copied" | yes | Open |
| BAR-NEGATIVE | Ask the Lab | Low | Bar chart with negative values | Zero-height bar (the label shows the number) | yes | Open |
| XLSX-CORRUPT | Intake | Low | `.xlsx` with garbage bytes | Reports "empty file" rather than "corrupt" | yes | Open |
| CSV-RAGGED | Intake | Low | Row with more cells than the header | Extra cells dropped silently | yes | Open |
| CSV-COMMAS-HEADER | Intake | Low | Header row of only commas | Treated as a blank row | yes | Open |
| RECIPE-BOM | Recipes | Low | Recipe JSON that starts with a BOM, via the API path | Rejected as invalid JSON (the UI reads through `file.text()`, not checked) | partly | Open |
| PROXY-NOMETHOD | API | Low | Call `handleAiProxyRequest` or `handleSqlProxyRequest` without `method` | Throws. Not reachable through the Node adapter. | yes | Open |

Counts: Critical 0, High 4 (all fixed), Medium 2 (both open, neither confirmed as a defect), Low 12 (open).

## Questions (not changed)

- XLSX reads only the first sheet, and a workbook whose first sheet is empty gives an empty-file error. Treated as intended.
- Non-ASCII column names are sanitised to `_`. Intended by the name sanitiser design?
- MM/DD versus DD/MM date interpretation.
- After "Back to tables", should the stitched result card stay visible?
- Should the CSV downloads carry a UTF-8 BOM (CSV-BOM) and should apply failures show a message (APPLY-SILENT)?

## Verified clean

CSV BOM stripped, UTF-16 and latin1 give a clear error, delimiters auto-detected, quoted newlines, CRLF and CR, duplicate and reserved-word headers, short ragged rows, same file twice, 100k rows (about 10 s). Mixed-type columns fall back to text. XLSX string cells are written as text (no formula evaluation), so the XLSX export needed no change. Recipes: hostile JSON, prototype pollution, deep nesting, huge size, wrong version, other tables, applying twice. `__proto__` and `constructor` names through intake, Autopsy, export, stitch and chips. Autopsy edge cases (no NaN, no exceptions). Frank, shelf and guide leave no timers or listeners after unmount; Calm Frank is safe when localStorage throws. MCP path guard (symlinks, NUL bytes, 25 MB limit, file name escapes). API proxies return 400, 405 or 503 for malformed bodies and missing env. Layout at 1280, 1440 and 1920 has no overflow or contrast failures; the keyboard-only flow works and the guide traps focus. All existing security bypass tests still pass.

## Not verified

- Firefox: Playwright could not launch it in this sandbox. Chromium and WebKit pass. A code scan found one regex lookbehind (`src/core/chat/redact-error.ts`, Safari 16.4+) and nothing else version-sensitive.
- The `security-auditor` and `spec-reviewer` agents were not invoked in this sweep; the review was done by hand.
- The production preview business flow passed in Chromium and WebKit before the fixes. After the fixes it was not repeated; the dev-server e2e suite (25 tests) and `npm run build` pass.

## Gate (CI=true)

`npm test` 208 files, 1437 tests pass. `npm run build`, `npm run check:api`, `npm run mcp:build` pass. `npm run test:e2e` 25 of 25 pass. Lint reports warnings only (existing React warnings).

## Test notes

Two existing property tests pinned the old XLSX behavior (UTC dates) and one pinned plain `=` for mixed join keys and verbatim CSV text; each was adjusted narrowly in the fixing commit.
