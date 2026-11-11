# Requirements Document

## Introduction

FrankenData is a client-side web application for the Kiroween 2026 hackathon (Frankenstein category) that combines mismatched technologies into a single mad-scientist-themed lab. This specification covers Feature 1 only: file intake. The user drags and drops CSV or XLSX files into the app, or loads built-in demo datasets. Each file is parsed client-side, its columns are typed by a custom TypeScript inference layer that tolerates messy real-world values, and the result is loaded as a table in an in-memory DuckDB-WASM database. Each loaded table is shown in a preview with its first 20 rows, column names, inferred column types, and total row count. Errors such as empty files, unsupported file types, oversized files, and bad encodings are surfaced clearly. PDF support, AI matching, and chat are out of scope and belong to later specs.

## Glossary

- **FrankenData**: The web application built for the Kiroween 2026 hackathon that combines React, Vite, TypeScript, DuckDB-WASM, PapaParse, and SheetJS into one client-side app.
- **FileIntake**: The subsystem of FrankenData responsible for accepting, parsing, type-inferring, and loading data files.
- **DropZone**: The user interface element that accepts dragged-and-dropped files.
- **DuckDB-WASM**: An in-browser SQL database engine compiled to WebAssembly that runs entirely in memory.
- **PapaParse**: A JavaScript library for parsing CSV files.
- **SheetJS**: A JavaScript library for parsing Excel (XLSX) files.
- **TypeInferenceLayer**: A custom TypeScript module that examines parsed values and infers each column's ColumnType.
- **DuckDBTable**: A table created in DuckDB-WASM from a single parsed file.
- **TablePreview**: The on-screen preview display of a loaded DuckDBTable.
- **ColumnType**: One of the supported inferred data types: number, boolean, date, or string.
- **NullToken**: A cell value that represents missing data: an empty cell, or the text N/A, NA, null, or a single hyphen, matched case-insensitively after trimming whitespace.
- **DemoDataset**: A built-in sample dataset bundled with FrankenData, containing intentionally messy values, that can be loaded without any user-supplied file.
- **CSV**: A comma-separated values file with a .csv extension.
- **XLSX**: A Microsoft Excel spreadsheet file with an .xlsx extension.
- **TestSuite**: The automated test suite accompanying FrankenData, including property-based tests.
- **RowCount**: The number of data rows in a parsed file or DuckDBTable.

## Requirements

### Requirement 1: Drag-and-Drop File Acceptance

**User Story:** As a data analyst, I want to drag and drop my data files into the app, so that I can load them into the lab for analysis.

#### Acceptance Criteria

1. WHEN the user drags files over the DropZone, THE FileIntake SHALL visually highlight the DropZone to indicate the DropZone accepts files.
2. WHEN the user drops files into the DropZone, THE FileIntake SHALL accept every dropped file regardless of the number of files dropped.
3. WHEN the number of dropped files is outside the 2-to-4 range, THE FileIntake SHALL display an informational message stating that 2 to 4 files is the intended range.
4. THE FileIntake SHALL process each accepted file independently of the other dropped files.

### Requirement 2: File Type and Size Validation

**User Story:** As a data analyst, I want the app to reject unsupported or oversized files clearly, so that I know which files can and cannot be loaded and the browser does not freeze.

#### Acceptance Criteria

1. WHEN a dropped file is received, THE FileIntake SHALL detect the file type from the file extension.
2. IF a dropped file has neither a .csv nor an .xlsx extension, THEN THE FileIntake SHALL mark the file as unsupported and display an error message naming the file.
3. IF a dropped file is larger than 25 MB, THEN THE FileIntake SHALL skip the file and display an error message naming the file and stating the 25 MB limit.
4. WHEN a dropped file has a .csv extension, THE FileIntake SHALL parse the file using PapaParse.
5. WHEN a dropped file has an .xlsx extension, THE FileIntake SHALL parse the file using SheetJS.

### Requirement 3: CSV Parsing

**User Story:** As a data analyst, I want CSV files parsed correctly, so that I can query them with SQL.

#### Acceptance Criteria

1. WHEN a CSV file is received, THE PapaParse SHALL parse the file into rows and columns.
2. IF a CSV file contains zero data rows, THEN THE FileIntake SHALL display an error message stating that the file is empty.
3. IF a CSV file has an encoding that prevents successful parsing, THEN THE FileIntake SHALL display an error message stating that the file has a bad encoding.
4. THE FileIntake SHALL preserve the column names from the first row of the CSV file, subject to the sanitization rules in Requirement 6.

### Requirement 4: XLSX Parsing

**User Story:** As a data analyst, I want XLSX files parsed correctly, so that I can query them with SQL.

#### Acceptance Criteria

1. WHEN an XLSX file is received, THE SheetJS SHALL parse the file into rows and columns.
2. IF an XLSX file contains no sheets or zero data rows, THEN THE FileIntake SHALL display an error message stating that the file is empty.
3. IF an XLSX file is corrupt or unreadable, THEN THE FileIntake SHALL display an error message stating that the file could not be read.
4. THE FileIntake SHALL preserve the column names from the first row of the first sheet of the XLSX file, subject to the sanitization rules in Requirement 6.
5. WHEN an XLSX cell is formatted as a date and SheetJS returns an Excel serial date number, THE FileIntake SHALL convert the value to a calendar date before type inference.

### Requirement 5: Type Inference for Messy Data

**User Story:** As a data analyst, I want each column to have an accurately inferred type even when my data is messy, so that SQL queries return correct results.

#### Acceptance Criteria

1. WHEN a file is parsed, THE TypeInferenceLayer SHALL evaluate the non-null values of each column to determine the ColumnType of that column.
2. THE TypeInferenceLayer SHALL treat every NullToken as a missing value, exclude it from type inference, and store it as SQL NULL.
3. THE TypeInferenceLayer SHALL classify each column as exactly one ColumnType: number, boolean, date, or string.
4. WHEN all non-null values of a column can be parsed as numbers, THE TypeInferenceLayer SHALL infer the column ColumnType as number, where a parsable number MAY include surrounding whitespace, a currency symbol ($, EUR, GBP, INR symbols), thousands separator commas, or a trailing percent sign.
5. WHEN a number value has a trailing percent sign, THE TypeInferenceLayer SHALL convert the value to its decimal fraction (for example, 12% becomes 0.12).
6. WHEN all non-null values of a column are one of true, false, yes, or no (case-insensitive), THE TypeInferenceLayer SHALL infer the column ColumnType as boolean.
7. WHEN all non-null values of a column can be parsed as dates in one of the ISO 8601 format, MM/DD/YYYY, DD-MM-YYYY, or a month-name format such as "Jan 5, 2026", THE TypeInferenceLayer SHALL infer the column ColumnType as date.
8. IF the non-null values of a column contain mixed or unparseable types, THEN THE TypeInferenceLayer SHALL infer the column ColumnType as string.
9. IF a column contains only NullTokens, THEN THE TypeInferenceLayer SHALL infer the column ColumnType as string.
10. THE TypeInferenceLayer SHALL return a ColumnType for any input without throwing an exception.

### Requirement 6: DuckDB-WASM Table Loading and Naming

**User Story:** As a data analyst, I want each file loaded as a queryable table with safe names, so that I can run SQL against my data without name errors.

#### Acceptance Criteria

1. WHEN a file is parsed and the columns are typed, THE FileIntake SHALL create a DuckDBTable in DuckDB-WASM with a name derived from the source file name.
2. THE FileIntake SHALL sanitize each table name by replacing spaces and symbols with underscores, prefixing names that start with a digit, and removing the file extension.
3. IF two loaded files would produce the same table name, THEN THE FileIntake SHALL make the names unique by appending a numeric suffix.
4. THE FileIntake SHALL sanitize column names by replacing blank names with a generated name, replacing spaces and special characters with underscores, and making duplicate names unique with a numeric suffix.
5. THE FileIntake SHALL create each DuckDBTable using the ColumnType values produced by the TypeInferenceLayer rather than relying on DuckDB auto-typing.
6. WHEN a DuckDBTable is created, THE FileIntake SHALL insert all parsed rows from the source file into the DuckDBTable.
7. IF converting a column to its inferred ColumnType fails during loading, THEN THE FileIntake SHALL load that column as string and still load the file.
8. IF DuckDBTable creation or row insertion fails for any other reason, THEN THE FileIntake SHALL display an error message naming the file and describing the failure reason.

### Requirement 7: Table Preview

**User Story:** As a data analyst, I want to see a preview of each loaded table, so that I can verify the data loaded correctly.

#### Acceptance Criteria

1. WHEN a DuckDBTable is created, THE FileIntake SHALL display a TablePreview for the DuckDBTable.
2. THE TablePreview SHALL display the first 20 rows of the DuckDBTable.
3. THE TablePreview SHALL display the column names of the DuckDBTable.
4. THE TablePreview SHALL display the inferred ColumnType of each column.
5. THE TablePreview SHALL display the RowCount of the DuckDBTable.

### Requirement 8: Ephemeral Persistence

**User Story:** As a data analyst, I want to understand that loaded data is temporary, so that I know the data clears when I refresh the page.

#### Acceptance Criteria

1. THE DuckDB-WASM SHALL run as an in-memory database with no persistent backing store.
2. WHEN the page is refreshed or closed, THE FileIntake SHALL discard all DuckDBTables and reset to the initial empty state.
3. THE FileIntake SHALL retain loaded DuckDBTables in memory only for the lifetime of the current browser session.

### Requirement 9: Error Handling and Continuation

**User Story:** As a data analyst, I want clear, non-blocking error messages, so that one bad file does not stop the rest from loading.

#### Acceptance Criteria

1. IF a file fails to parse or load, THEN THE FileIntake SHALL display an error message that names the file and describes the failure.
2. WHEN a file produces an error, THE FileIntake SHALL continue processing the remaining dropped files.
3. THE FileIntake SHALL display error messages in a location visible to the user without obscuring successfully loaded TablePreviews.

### Requirement 10: Property-Based Tests for Parsing and Type Inference

**User Story:** As a developer, I want property-based tests covering the parsing and type inference logic, so that I can verify the core logic is robust across varied inputs.

#### Acceptance Criteria

1. THE TestSuite SHALL include property-based tests verifying that CSV parsing produces the expected rows and columns for valid CSV inputs of varying row and column counts.
2. THE TestSuite SHALL include property-based tests verifying that XLSX parsing produces the expected rows and columns for valid XLSX inputs of varying row and column counts.
3. THE TestSuite SHALL include property-based tests verifying that the TypeInferenceLayer classifies a column of all numbers as the number ColumnType.
4. THE TestSuite SHALL include property-based tests verifying that the TypeInferenceLayer classifies a column of all booleans as the boolean ColumnType.
5. THE TestSuite SHALL include property-based tests verifying that the TypeInferenceLayer classifies a column of all dates as the date ColumnType.
6. THE TestSuite SHALL include property-based tests verifying that the TypeInferenceLayer classifies a column of mixed types as the string ColumnType.
7. THE TestSuite SHALL include a round-trip property test verifying that a number formatted with a currency symbol, thousands separators, or surrounding whitespace parses back to the same numeric value.
8. THE TestSuite SHALL include a property test verifying that the TypeInferenceLayer does not throw for arbitrary string inputs.
9. THE TestSuite SHALL include a property test verifying that columns containing NullTokens mixed with numbers are still inferred as number.

### Requirement 11: Application Foundation and Tech Stack

**User Story:** As a developer, I want the app built on a defined client-side tech stack, so that the app runs entirely in the browser.

#### Acceptance Criteria

1. THE FrankenData SHALL be built with React, Vite, and TypeScript.
2. THE FrankenData SHALL run DuckDB-WASM client-side in the browser.
3. THE FrankenData SHALL parse files client-side using PapaParse for CSV files and SheetJS for XLSX files.

### Requirement 12: Spooky Mad-Scientist Visual Theme

**User Story:** As a participant, I want a polished spooky mad-scientist lab theme, so that the app is engaging and readable.

#### Acceptance Criteria

1. THE FileIntake SHALL apply a spooky mad-scientist lab visual theme to the file intake interface.
2. WHILE the mad-scientist lab visual theme is applied, THE FileIntake SHALL render body text with a contrast ratio of at least 4.5:1 against the themed background.
3. THE TablePreview SHALL render tabular data with visible column separators and headers that remain readable against the themed background.

### Requirement 13: Demo Data

**User Story:** As a judge or first-time user, I want to try the app without my own files, so that I can see it work immediately.

#### Acceptance Criteria

1. THE FileIntake SHALL display a "Load demo data" control alongside the DropZone.
2. WHEN the user activates the "Load demo data" control, THE FileIntake SHALL load three DemoDatasets through the same parsing, type inference, and loading pipeline used for dropped files.
3. THE DemoDatasets SHALL contain intentionally messy values, including currency-formatted numbers, percent values, NullTokens, and dates in more than one format.
4. THE DemoDatasets SHALL be bundled with FrankenData so that loading them requires no network access.