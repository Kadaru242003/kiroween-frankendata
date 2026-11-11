# Implementation Plan: FrankenData File Intake

## Overview

FrankenData is a client-side React + Vite + TypeScript web app for the Kiroween 2026 hackathon (Frankenstein category). Feature 1 — file intake — lets the user drag and drop CSV/XLSX files (or load bundled demo datasets); each file is parsed client-side, its columns are typed by a custom TypeScript inference layer that tolerates messy real-world values, and the result is loaded as an explicitly typed table in an in-memory DuckDB-WASM database. A preview of each table is rendered (first 20 rows, column names, inferred types, row count), and errors are surfaced clearly and non-blockingly.

The implementation is organized as a pipeline of pure-ish, framework-agnostic TypeScript modules behind a thin `IntakeController` orchestration layer, with React components only at the edges (drop zone, preview, errors, demo control). Keeping parsing, type inference, name sanitization, and value coercion in pure TypeScript modules lets the core logic be unit- and property-tested (via `fast-check`, minimum 100 iterations per property) without rendering React or spinning up DuckDB where possible.

**Task ordering rules applied to this plan:**
- The first task proves DuckDB-WASM initializes and runs inside the Vite + TypeScript project before any real logic is built.
- All core logic (file detection, size validation, CSV/XLSX parsing, type inference, name sanitization, DuckDB service, intake orchestration) and their associated property-based tests come BEFORE any UI tasks (DropZone, TablePreview, ErrorDisplay, demo control UI, theme).
- Core-logic property tests are REQUIRED (no `*`); UI-related property tests (Property 9, Property 28) and non-core tests (theme contrast, demo-data unit tests, integration tests, persistence-config smoke tests) are OPTIONAL (`*`).

Tasks are incremental: each builds on the previous, ending with full wiring in the App. Each property test sub-task is its own dedicated test file so property tests for one module can execute in parallel.

## Tasks

- [x] 1. Project foundation and DuckDB-WASM smoke test
  - [x] 1.1 Scaffold the React + Vite + TypeScript app and install dependencies
    - Initialize a Vite React-TS project in the workspace root
    - Install runtime deps: `@duckdb/duckdb-wasm`, `papaparse`, `xlsx` (SheetJS), and their `@types`
    - Install dev/test deps: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `fast-check`
    - Add a Vitest config and an npm `test` script using `--run` (single execution, no watch)
    - _Requirements: 11.1, 11.2, 11.3_

  - [x] 1.2 Write the DuckDB-WASM initialization smoke test
    - Initialize a single in-memory `@duckdb/duckdb-wasm` instance and run a trivial query (e.g., `SELECT 1`)
    - Assert the instance is in-memory with no persistent backing store, proving the foundational integration works before building real logic
    - _Requirements: 8.1, 11.2_

- [x] 2. Define core types and interfaces
  - [x] 2.1 Create shared type definitions and module interfaces
    - Define `ColumnType`, `FileType`, `ColumnSchema`, `CellValue`, `ParsedFile`, `LoadedTable`, `IntakeError`, and the `FileParser`, `TypeInferenceLayer`, `NameSanitizer`, `DuckDBService`, `DemoDataLoader`, `IntakeController` interfaces exactly as specified in the design
    - Define the `ColumnType`→DuckDB type mapping (`number`→`DOUBLE`, `boolean`→`BOOLEAN`, `date`→`DATE`, `string`→`VARCHAR`)
    - _Requirements: 5.3, 6.5, 11.1_

- [x] 3. Implement file type detection
  - [x] 3.1 Implement `detectType`
    - Pure function mapping a file name's extension to `FileType` (`csv` | `xlsx` | `unsupported`), case-insensitive
    - _Requirements: 2.1, 2.2_

  - [x] 3.2 Write property test for file type routing from extension
    - **Property 6: File type routing from extension**
    - **Validates: Requirements 2.1, 2.2**

- [x] 4. Implement file size validation
  - [x] 4.1 Implement `checkSize`
    - Pure guard returning `null` if a file is within the 25 MB limit, else an `IntakeError` (`oversized`) naming the file and stating the 25 MB limit
    - _Requirements: 2.3_

  - [x] 4.2 Write property test for file size limit enforcement
    - **Property 7: File size limit enforcement**
    - **Validates: Requirements 2.3**

- [x] 5. Implement CSV parsing
  - [x] 5.1 Implement `CsvParser` (PapaParse wrapper)
    - Read the file as text and parse into rows/columns with PapaParse
    - Preserve the first row as `columnNames`; return data rows only in `ParsedFile.rows`
    - Detect empty files (zero data rows) → `IntakeError` (`empty-file`)
    - Detect bad encodings (undecodable bytes) → `IntakeError` (`bad-encoding`)
    - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4_

  - [x] 5.2 Write property test for CSV parsing fidelity
    - **Property 1: CSV parsing fidelity**
    - **Validates: Requirements 3.1, 3.4, 10.1**

  - [x] 5.3 Write property tests for empty and unreadable CSV detection
    - **Property 3: Empty file detection** (CSV portion)
    - **Property 4: Unreadable file detection** (CSV portion)
    - **Validates: Requirements 3.2, 3.3**

- [x] 6. Implement XLSX parsing
  - [x] 6.1 Implement `XlsxParser` (SheetJS wrapper) with cell-value string normalization
    - Read the file as an `ArrayBuffer` and parse the first sheet with SheetJS
    - Preserve the first row of the first sheet as `columnNames`; return data rows only
    - Normalize every cell value to a consistent string before type inference: numbers → string form, booleans → `"true"`/`"false"`, `Date` objects and Excel serial-date numbers → ISO `YYYY-MM-DD` string, strings → as-is
    - For date cells where SheetJS returns an Excel serial date number, convert the serial to a calendar date and then to its ISO `YYYY-MM-DD` string
    - Detect empty workbooks (no sheets / zero data rows) → `IntakeError` (`empty-file`)
    - Detect corrupt/unreadable files → `IntakeError` (`corrupt-file`)
    - _Requirements: 2.5, 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 6.2 Write property test for XLSX parsing fidelity
    - **Property 2: XLSX parsing fidelity**
    - **Validates: Requirements 4.1, 4.4, 10.2**

  - [x] 6.3 Write property tests for empty and unreadable XLSX detection
    - **Property 3: Empty file detection** (XLSX portion)
    - **Property 4: Unreadable file detection** (XLSX portion)
    - **Validates: Requirements 4.2, 4.3**

  - [x] 6.4 Write property test for Excel serial date conversion
    - **Property 5: Excel serial date conversion**
    - **Validates: Requirements 4.5**

  - [x] 6.5 Write property test for XLSX cell value string normalization
    - **Property 30: XLSX cell value string normalization**
    - **Validates: Requirements 4.1, 4.5**

- [x] 7. Implement type inference and value coercion
  - [x] 7.1 Implement per-value predicates
    - `isNullToken`: empty/whitespace-only cells and the text `N/A`, `NA`, `null`, or a single hyphen `-` (case-insensitive after trimming)
    - `isNumber`: trimmed value is parsable after stripping optional surrounding whitespace, a leading currency symbol (`$`, `€`, `£`, `₹`, `EUR`/`GBP`/`INR`), thousands-separator commas, and an optional trailing percent sign; bare `42`, `-3.14`, `1e3`, `0` also satisfy it
    - `isBoolean`: matches `^(true|false|yes|no)$` case-insensitively after trimming; bare `0`/`1` are NOT booleans (predicates stay mutually exclusive)
    - `isDate`: matches ISO 8601 (`YYYY-MM-DD`), `MM/DD/YYYY` (month-first), `DD-MM-YYYY` (day-first), or a month-name format such as `Jan 5, 2026` and parses to a valid calendar date; a bare 4-digit year is NOT a date
    - _Requirements: 5.2, 5.4, 5.6, 5.7_

  - [x] 7.2 Implement `TypeInferenceLayer.infer` column classification
    - For each column, exclude `NullToken` values, then classify: all-numbers → `number`; else all-booleans → `boolean`; else all-dates → `date`; else → `string`
    - A column with zero non-`NullToken` values is classified `string`
    - Return a `ColumnType` for any input without throwing; never rely on DuckDB auto-typing
    - _Requirements: 5.1, 5.3, 5.8, 5.9, 5.10_

  - [x] 7.3 Implement value coercion helpers
    - Percent-to-decimal conversion: a trailing percent sign converts to its decimal fraction (`12%` → `0.12`)
    - Number format/parse helper: wrap a number with a currency symbol, thousands separators, or surrounding whitespace and parse it back to the same value (round trip)
    - Date-to-ISO normalization: normalize any recognized date format — ISO 8601 (`YYYY-MM-DD`), `MM/DD/YYYY` (month-first; slashes read as `MM/DD/YYYY`, not `DD/MM/YYYY`), `DD-MM-YYYY` (day-first), month-name — to canonical ISO `YYYY-MM-DD`; idempotent for already-ISO values
    - _Requirements: 4.5, 5.5, 5.7_

  - [x] 7.4 Write property test for type inference total classification
    - **Property 11: Type inference total classification**
    - **Validates: Requirements 5.3**

  - [x] 7.5 Write property test for all-numbers infer number (incl. NullToken-mixed)
    - **Property 13: All-numbers infer number (including NullToken-mixed columns)**
    - **Validates: Requirements 5.4, 10.3, 10.9**

  - [x] 7.6 Write property test for percent-to-decimal conversion
    - **Property 14: Percent-to-decimal conversion**
    - **Validates: Requirements 5.5**

  - [x] 7.7 Write property test for number formatting round trip
    - **Property 15: Number formatting round trip**
    - **Validates: Requirements 10.7**

  - [x] 7.8 Write property test for all-booleans infer boolean
    - **Property 16: All-booleans infer boolean**
    - **Validates: Requirements 5.6, 10.4**

  - [x] 7.9 Write property test for all-dates infer date
    - **Property 17: All-dates infer date**
    - **Validates: Requirements 5.7, 10.5**

  - [x] 7.10 Write property test for mixed or unparseable infer string
    - **Property 18: Mixed or unparseable infer string**
    - **Validates: Requirements 5.8, 10.6**

  - [x] 7.11 Write property test for all-NullToken column infers string
    - **Property 19: All-NullToken column infers string**
    - **Validates: Requirements 5.9**

  - [x] 7.12 Write property test for inference never throws
    - **Property 20: Inference never throws**
    - **Validates: Requirements 5.10, 10.8**

  - [x] 7.13 Write property test for date normalization to ISO YYYY-MM-DD
    - **Property 29: Date normalization to ISO YYYY-MM-DD**
    - **Validates: Requirements 4.5, 5.7**

- [x] 8. Checkpoint - core logic tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement name sanitization
  - [x] 9.1 Implement `NameSanitizer`
    - `sanitizeTableName`: strip directory and extension, replace non-`[A-Za-z0-9_]` with `_`, collapse consecutive underscores, lowercase, prefix `t_` if it starts with a digit, append numeric suffix on collision with `existingNames`
    - `sanitizeColumnNames`: replace blank names with generated names (`column_1`, … by position), replace spaces/special chars with `_`, make duplicates unique with numeric suffixes preserving the first occurrence; uniqueness checked case-insensitively so names differing only in case (e.g., `Name` and `name`) are disambiguated with a suffix
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 9.2 Write property test for table name derivation and sanitization
    - **Property 21: Table name derivation and sanitization**
    - **Validates: Requirements 6.1, 6.2**

  - [x] 9.3 Write property test for table name uniqueness
    - **Property 22: Table name uniqueness**
    - **Validates: Requirements 6.3**

  - [x] 9.4 Write property test for column name sanitization
    - **Property 23: Column name sanitization**
    - **Validates: Requirements 6.4**

- [x] 10. Implement the DuckDB-WASM service
  - [x] 10.1 Implement `DuckDBService` (init, typed table creation, insertion, fallback, queries)
    - Create a single in-memory `@duckdb/duckdb-wasm` instance with no persistent backing store
    - `createTable`: issue `CREATE TABLE "name" (col1 DOUBLE, …)` using the inferred `ColumnSchema` (never `CREATE TABLE … AS SELECT` auto-typing), insert all rows via parameterized statements/appender with values coerced to the column's DuckDB type (null stays `NULL`, numeric strings → `DOUBLE`, boolean literals → `BOOLEAN`, date strings normalized to ISO `YYYY-MM-DD` → `DATE`, others → `VARCHAR`), assert inserted row count equals parsed row count
    - String fallback: if converting a column's values to its inferred DuckDB type fails, recreate/load that column as `VARCHAR` and still load the file; other failures produce `IntakeError` (`table-load-failed`) naming the file and the failure reason
    - `getRowCount`/`getPreviewRows`/`query` helpers for previews
    - _Requirements: 6.5, 6.6, 6.7, 6.8, 7.2, 7.5, 8.1, 11.2_

  - [x] 10.2 Write property test for DuckDB table uses inferred types
    - **Property 24: DuckDB table uses inferred types**
    - **Validates: Requirements 6.5**

  - [x] 10.3 Write property test for row count preservation
    - **Property 25: Row count preservation**
    - **Validates: Requirements 6.6**

  - [x] 10.4 Write property test for string fallback on conversion failure
    - **Property 26: String fallback on conversion failure**
    - **Validates: Requirements 6.7**

  - [x] 10.5 Write property test for NullToken exclusion and NULL storage
    - **Property 12: NullToken exclusion and NULL storage**
    - **Validates: Requirements 5.2**

- [x] 11. Checkpoint - core logic tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement intake orchestration and session store
  - [x] 12.1 Implement `IntakeController` (per-file pipeline)
    - Orchestrate per file: `detectType` → size check → parser → `TypeInferenceLayer` → `NameSanitizer` → `DuckDBService`, publishing results to `IntakeStore`
    - Process each file independently in its own `try/catch` so a failure never halts the remaining files; accept every dropped file regardless of count
    - Surface load failures as `IntakeError` naming the file and describing the failure; same controller used for dropped files and demo datasets
    - _Requirements: 1.2, 1.4, 6.1, 6.8, 9.1, 9.2_

  - [x] 12.2 Implement `IntakeStore` (session state)
    - Hold the list of `LoadedTable` descriptors and `IntakeError` entries for the current session only; no persistence (a refresh recreates an empty store and fresh DuckDB instance)
    - _Requirements: 7.1, 8.2, 8.3, 9.3_

  - [x] 12.3 Write property test for accept all dropped files
    - **Property 8: Accept all dropped files**
    - **Validates: Requirements 1.2**

  - [x] 12.4 Write property test for independent processing and failure isolation
    - **Property 10: Independent processing and failure isolation**
    - **Validates: Requirements 1.4, 9.2**

  - [x] 12.5 Write property test for load failure error names the file
    - **Property 27: Load failure error names the file**
    - **Validates: Requirements 6.8, 9.1**

- [x] 13. Checkpoint - all core logic tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Apply the spooky mad-scientist visual theme
  - [x] 14.1 Implement the lab theme and contrast color tokens
    - Dark lab background with a restrained palette of laboratory greens, purples, and amber accents
    - Define theme color tokens once so contrast can be checked; body text in a high-contrast light tone against the dark background (≥ 4.5:1)
    - Theme is presentation-only; it does not affect the pure core logic
    - _Requirements: 12.1, 12.2_

  - [x] 14.2 Style the DropZone as a lab intake port
    - Apply lab-themed styling and a clear drag-over highlight state to the DropZone
    - _Requirements: 1.1, 12.1_

  - [x] 14.3 Style the TablePreview with readable headers and separators
    - Visible column separators and sticky, readable headers against the themed background
    - _Requirements: 7.2, 7.3, 7.4, 12.3_

  - [ ]* 14.4 Write unit test for theme contrast over color-token pairs
    - Example-based test asserting a contrast ratio of at least 4.5:1 over the defined theme color-token pairs
    - _Requirements: 12.2_

- [x] 15. Implement the DropZone UI
  - [x] 15.1 Implement `DropZone`
    - Accept dragged-and-dropped files; visually highlight on drag-over
    - On drop, forward the `File[]` to the `IntakeController`; accept every dropped file regardless of count
    - Show the informational "2 to 4 files is the intended range" message when the count is outside the 2–4 range (acceptance, not rejection)
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 15.2 Write property test for file-count guidance message
    - **Property 9: File-count guidance message**
    - **Validates: Requirements 1.3**

- [x] 16. Implement the TablePreview UI
  - [x] 16.1 Implement `TablePreview`
    - Render one card per loaded table: first `min(rowCount, 20)` rows, column names, inferred column types, and total row count
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 16.2 Write property test for preview completeness
    - **Property 28: Preview completeness**
    - **Validates: Requirements 7.2, 7.3, 7.4, 7.5**

- [x] 17. Implement the ErrorDisplay UI
  - [x] 17.1 Implement `ErrorDisplay`
    - Render the list of `IntakeError` entries in a panel that is visible without obscuring the table previews; each error names the file and describes the failure
    - _Requirements: 9.1, 9.3_

- [x] 18. Implement demo data
  - [x] 18.1 Implement `DemoDataLoader`
    - Bundle three `DemoDataset` fixtures as static assets (CSV strings embedded in the bundle, no network access) containing intentionally messy values: currency-formatted numbers, percent values, `NullToken`s in various forms, and dates in more than one format
    - `load()` returns three `File` objects constructed from the bundled data and routes them through the same `IntakeController` pipeline used for dropped files
    - _Requirements: 13.2, 13.3, 13.4_

  - [x] 18.2 Implement `DemoDataControl`
    - Render a "Load demo data" control alongside the DropZone; on activation invoke `DemoDataLoader`
    - _Requirements: 13.1, 13.2_

  - [ ]* 18.3 Write unit tests for demo dataset contents
    - Assert the three bundled datasets contain messy values (currency, percent, `NullToken`s, multiple date formats)
    - _Requirements: 13.3_

  - [ ]* 18.4 Write smoke test for demo data bundling
    - Assert datasets are bundled with the app so loading requires no network access
    - _Requirements: 13.4_

- [x] 19. Integration and wiring
  - [x] 19.1 Wire the pipeline into the App
    - Initialize the `DuckDBService` on app start, mount `DropZone`, `DemoDataControl`, `TablePreview`(s), and `ErrorDisplay` against the `IntakeStore`; connect `DropZone`/`DemoDataControl` to the `IntakeController`
    - _Requirements: 1.1, 7.1, 9.3, 11.1, 11.2, 13.1_

  - [ ]* 19.2 Write integration test for the full pipeline round trip
    - Example-based integration test: parse a representative CSV and XLSX file → infer types → create typed DuckDB table → assert preview rows, types, and row count via the in-memory DuckDB instance
    - _Requirements: 3.1, 4.1, 5.3, 6.5, 6.6, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 19.3 Write smoke tests for persistence configuration
    - Assert DuckDB is configured in-memory with no persistent backing store (no IndexedDB) and that the toolchain (React + Vite + TS, DuckDB-WASM client-side, PapaParse, SheetJS) is wired
    - _Requirements: 8.1, 8.3, 11.1, 11.2, 11.3_

- [x] 20. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; core implementation tasks and core-logic property tests are never optional.
- Core-logic property tests (parsing fidelity, type inference, name sanitization, DuckDB types/row-count/string-fallback, NullToken exclusion, independent processing, load-failure naming, date normalization, XLSX cell normalization) are REQUIRED. UI-related property tests (Property 9, Property 28) and non-core tests (theme contrast, demo-data unit/smoke tests, integration tests, persistence-config smoke tests) are OPTIONAL.
- Each task references specific requirement clauses for traceability; property-test sub-tasks annotate their design property number and the requirement(s) they validate.
- Property-based tests use `fast-check` with a minimum of 100 iterations per property, targeting framework-agnostic core modules so they run quickly and deterministically without a browser or DuckDB where possible. DuckDB-backed properties (types, row count, string fallback, NullToken→NULL) use the in-memory DuckDB instance with small generated tables.
- Each property test sub-task is its own dedicated test file so property tests for one module can execute in parallel without file conflicts.
- Checkpoints ensure incremental validation at foundation, parsing, type inference, core pipeline, and final stages.
- The pure core modules (`detectType`, `checkSize`, parsers, `TypeInferenceLayer`, `NameSanitizer`, value-coercion helpers) are developed independently of React/DuckDB so they are unit- and property-testable in isolation.
- Demo data is bundled so it routes through the identical parsing/inference/loading pipeline used for dropped files (no separate code path).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["3.1", "4.1", "5.1", "6.1", "7.1", "9.1", "12.2"] },
    { "id": 3, "tasks": ["7.2", "7.3", "3.2", "4.2", "5.2", "5.3", "6.2", "6.3", "6.4", "6.5", "9.2", "9.3", "9.4"] },
    { "id": 4, "tasks": ["7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10", "7.11", "7.12", "7.13", "10.1"] },
    { "id": 5, "tasks": ["10.2", "10.3", "10.4", "10.5", "12.1"] },
    { "id": 6, "tasks": ["12.3", "12.4", "12.5"] },
    { "id": 7, "tasks": ["14.1", "18.1"] },
    { "id": 8, "tasks": ["15.1", "16.1", "17.1", "14.4"] },
    { "id": 9, "tasks": ["14.2", "14.3", "15.2", "16.2", "18.2", "18.3", "18.4"] },
    { "id": 10, "tasks": ["19.1"] },
    { "id": 11, "tasks": ["19.2", "19.3"] }
  ]
}
```
