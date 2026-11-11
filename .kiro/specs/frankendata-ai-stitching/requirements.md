# Requirements Document

## Introduction

FrankenData is a client-side, browser-only web application for the Kiroween 2026 hackathon (Frankenstein category). Feature 1 (see `.kiro/specs/frankendata-file-intake`) already loads messy CSV/XLSX files into typed, in-memory DuckDB-WASM tables. This specification covers Feature 2: **AI Stitching and Cleaning**.

When two or more tables are loaded, FrankenData proposes how to stitch them together (which columns across tables refer to the same thing) and how to clean each table (whitespace/case normalization, category standardization, likely duplicates, outliers). Every proposal is shown to the user as a before/after diff on an approval screen; nothing is applied until the user approves. Applying proposals creates new DuckDB tables or views and never destroys the originals, and the whole stitching step can be undone. After approval, a stitched (joined) table is created from the approved matches and shown with the existing TablePreview.

A deterministic, fully offline rules engine produces all proposals (fuzzy name similarity, type compatibility, value overlap, rule-based cleaning). An optional LLM enhancement, accessed through an `AiProvider` interface and a small serverless proxy, may improve match quality and explanations — but the app must never depend on it: if the proxy is rate limited, over budget, or unreachable, the app silently falls back to the rules engine and shows a small notice. No API key ever ships in the client, and only column names and a few sample values per column are ever sent to the proxy — never full rows.

Chat, charts, and export are out of scope and belong to a later spec.

## Glossary

- **FrankenData**: The client-side web application that stitches together mismatched technologies (React, Vite, TypeScript, DuckDB-WASM, PapaParse, SheetJS) for the Kiroween 2026 hackathon.
- **LoadedTable**: A table already parsed, typed, and loaded into DuckDB-WASM by Feature 1 (file intake). Defined in `src/core/types.ts`.
- **ColumnType**: One of the inferred types from Feature 1: `number`, `boolean`, `date`, or `string`.
- **StitchingEngine**: The deterministic, framework-agnostic core module that produces all match and cleaning proposals offline with no network access.
- **MatchProposal**: A proposed correspondence between a column in one LoadedTable and a column in another LoadedTable, carrying a confidence score and a one-line reason.
- **CleaningProposal**: A proposed transformation of a single column within one LoadedTable (whitespace/case normalization, category standardization, duplicate flag, or outlier flag), carrying a before/after representation and a one-line reason.
- **Proposal**: A MatchProposal or a CleaningProposal.
- **ConfidenceScore**: A number in the inclusive range 0 to 1 attached to each Proposal indicating how strongly the engine believes the proposal is correct.
- **ApprovalDecision**: The user's decision on a single Proposal: approved, rejected, or edited.
- **ApprovalScreen**: The user interface that lists every Proposal as a before/after diff and collects ApprovalDecisions.
- **StitchPlan**: The set of approved and edited Proposals the user has committed to apply.
- **StitchedTable**: A new joined DuckDBTable created from the approved MatchProposals after approval.
- **AiProvider**: An interface for an optional LLM enhancement that refines match scores and explanations; it is fakeable for tests and has one production implementation that calls a serverless proxy.
- **AiProxy**: A small serverless endpoint that holds the LLM API key server-side and relays only column names and sample values, so no key ships in the client.
- **RulesEngine**: The deterministic matching and cleaning logic inside the StitchingEngine; the always-available baseline and fallback.
- **SampleValues**: A small, bounded number of example cell values per column (never full rows) that may be sent to the AiProxy.
- **UndoStep**: A single reversible operation that restores the application to the state immediately before the StitchPlan was applied.
- **AnchorTable**: The table that begins the LEFT JOIN chain when a StitchedTable is built. Defaults to the LoadedTable with the most rows and can be changed by the user.
- **DuckDBTable**: A table created in the in-memory DuckDB-WASM database. Includes the original LoadedTables, the cleaned copies, and the StitchedTable.
- **TestSuite**: The automated test suite accompanying FrankenData, including the property-based tests (`fast-check`) for the deterministic StitchingEngine and the AI fallback.

## Named Constants

These constants are referenced by the requirements below and SHALL be exposed as named values in the implementation so that tests and the UI can reference them rather than hard-coding literals.

- **MATCH_DISPLAY_THRESHOLD = 0.5** — MatchProposals with a ConfidenceScore below this value are not shown on the ApprovalScreen.
- **HIGH_CONFIDENCE_THRESHOLD = 0.85** — A Proposal is "high-confidence" when its ConfidenceScore is at or above this value; this is the threshold the "approve all high-confidence" action applies to.
- **AI_REQUEST_TIMEOUT_MS = 8000** — The client-side timeout (8 seconds) applied to each AiProxy request; a request that exceeds it is treated as a failure.
- **MAX_SAMPLE_VALUES_PER_COLUMN = 200** — The maximum number of distinct SampleValues per column used for matching, cleaning, and anything sent to the AiProxy.
- **AI_PROXY_PER_CLIENT_LIMIT = 20** — The maximum number of AiProxy requests allowed per client per hour (per-client rate limit).
- **AI_PROXY_DAILY_REQUEST_CAP = 500** — The maximum number of AiProxy requests allowed across all clients per day (global daily spending cap).
- **AI_PROXY_MAX_PAYLOAD_BYTES = 20480** — The maximum AiProxy request payload size in bytes (20 KiB).

## Requirements

### Requirement 1: Cross-Table Column Matching

**User Story:** As a data analyst, I want the app to propose which columns across my loaded tables refer to the same thing, so that I can join mismatched files without hand-mapping every column.

#### Acceptance Criteria

1. WHEN two or more LoadedTables are present, THE StitchingEngine SHALL evaluate every unordered pair of LoadedTables and propose MatchProposals between their columns.
2. THE StitchingEngine SHALL base each MatchProposal on fuzzy column-name similarity, ColumnType compatibility, and overlap of SampleValues, so that columns referring to the same thing are matched even when their names differ (for example "Monster Name" and "name", or "scientist" and "lead_scientist").
3. THE StitchingEngine SHALL attach to every MatchProposal a ConfidenceScore in the inclusive range 0 to 1 and a one-line human-readable reason.
4. THE StitchingEngine SHALL produce MatchProposals symmetrically, so that the set of proposals for the pair (A, B) is equivalent to the set for the pair (B, A), with identical ConfidenceScores.
5. THE StitchingEngine SHALL NOT propose a match between two columns whose ColumnTypes are incompatible.
6. THE ApprovalScreen SHALL NOT display any MatchProposal whose ConfidenceScore is below MATCH_DISPLAY_THRESHOLD (0.5).

### Requirement 2: Per-Table Cleaning Proposals

**User Story:** As a data analyst, I want the app to propose cleanups for each table, so that inconsistent values do not break my joins and queries.

#### Acceptance Criteria

1. WHEN a LoadedTable is present, THE StitchingEngine SHALL propose CleaningProposals that trim and normalize surrounding whitespace and case for text columns.
2. THE StitchingEngine SHALL propose CleaningProposals that standardize inconsistent category values that denote the same category (for example "Swamp Wraith", "swamp-wraith", and "swamp wraith").
3. THE StitchingEngine SHALL propose CleaningProposals that flag likely duplicate rows.
4. WHEN the user approves a duplicate-row CleaningProposal, THE StitchingEngine SHALL remove the duplicate rows in the cleaned copy only, keeping the first occurrence of each duplicated row.
5. THE StitchingEngine SHALL propose CleaningProposals that flag likely outlier values, and SHALL apply outlier detection to number columns only.
6. WHEN the user approves an outlier CleaningProposal, THE StitchingEngine SHALL add an `is_outlier` boolean column to the cleaned copy and SHALL NOT remove any rows.
7. THE StitchingEngine SHALL attach to every CleaningProposal a before/after representation and a one-line human-readable reason.
8. WHEN a CleaningProposal is applied twice in succession to already-cleaned data, THE StitchingEngine SHALL produce the same result as applying it once (idempotence).
9. THE StitchingEngine SHALL compute matching and cleaning using at most MAX_SAMPLE_VALUES_PER_COLUMN (200) distinct SampleValues per column.

### Requirement 3: Approval Screen with Before/After Diffs

**User Story:** As a data analyst, I want to review every proposal as a before/after diff and decide on each one, so that I stay in control of what changes.

#### Acceptance Criteria

1. THE ApprovalScreen SHALL display every MatchProposal and CleaningProposal as a before/after diff that shows the proposed change.
2. THE ApprovalScreen SHALL allow the user to approve, reject, or edit each Proposal individually.
3. THE ApprovalScreen SHALL provide an "approve all high-confidence" action that approves every Proposal whose ConfidenceScore is at or above HIGH_CONFIDENCE_THRESHOLD (0.85).
4. WHILE no approval action has been taken, THE StitchingEngine SHALL NOT apply any Proposal or alter any LoadedTable.
5. THE ApprovalScreen SHALL assemble the approved and edited Proposals into a StitchPlan that is applied only when the user confirms.
6. WHEN the user edits a MatchProposal, THE ApprovalScreen SHALL change which column in the other table the proposal pairs to.
7. WHEN the user edits a category-standardization CleaningProposal, THE ApprovalScreen SHALL change the target canonical value the inconsistent values are standardized to.
8. WHEN the set of LoadedTables changes, THE StitchingEngine SHALL discard existing Proposals and ApprovalDecisions, recompute the Proposals, and THE FrankenData SHALL inform the user that proposals were recomputed.

### Requirement 4: Non-Destructive Apply and Undo

**User Story:** As a data analyst, I want applying changes to never destroy my originals and to be undoable, so that I can experiment without losing data.

#### Acceptance Criteria

1. WHEN the user applies a StitchPlan, THE StitchingEngine SHALL create new DuckDBTables or views for the results and SHALL leave every original LoadedTable unchanged.
2. THE StitchingEngine SHALL record an UndoStep when a StitchPlan is applied.
3. WHEN the user undoes the stitching step, THE StitchingEngine SHALL restore the application to the state immediately before the StitchPlan was applied, including removing any tables or views the apply created.
4. THE StitchingEngine SHALL keep all data in the browser and the DuckDB-WASM database in memory, with no persistence and no network access for apply and undo.

### Requirement 5: Deterministic Offline Rules Engine

**User Story:** As a developer, I want all proposals produced by a deterministic offline engine, so that the feature works with no network and gives repeatable results.

#### Acceptance Criteria

1. THE RulesEngine SHALL produce all MatchProposals and CleaningProposals with no network access.
2. THE RulesEngine SHALL be deterministic, so that the same LoadedTables yield the same Proposals with the same ConfidenceScores on every run.
3. THE RulesEngine SHALL compute matches from fuzzy name similarity, ColumnType compatibility, and SampleValues overlap, and SHALL compute cleaning from rule-based transformations.
4. THE RulesEngine SHALL be implemented as framework-agnostic core logic with no dependency on React or the DOM, following the project structure in `.kiro/steering/structure.md`.

### Requirement 6: Optional AI Enhancement Behind AiProvider

**User Story:** As a data analyst, I want optional AI to improve match quality and explanations, so that I get better proposals when it is available without ever risking a broken app or leaked key.

#### Acceptance Criteria

1. THE AiProvider SHALL be defined as an interface that the StitchingEngine calls to optionally refine MatchProposal ConfidenceScores and reasons.
2. WHEN the AiProvider is used, THE FrankenData SHALL send only column names and a bounded number of SampleValues per column, and SHALL NOT send full rows.
3. THE FrankenData SHALL reach the LLM only through the AiProxy, so that no API key is included in the client bundle.
4. THE ApprovalScreen SHALL inform the user that only column names and sample values are sent when the AI enhancement is active.
5. IF the AiProxy is rate limited, over budget, unreachable, or returns an error, THEN THE StitchingEngine SHALL fall back to the RulesEngine result and THE FrankenData SHALL display a small notice that AI was unavailable.
6. THE FrankenData SHALL remain fully functional using the RulesEngine when the AiProvider is absent or fails, so that the app never breaks because the AI is unavailable.
7. THE AiProvider SHALL be fakeable so that tests can exercise success and failure paths with no real network calls.
8. THE ApprovalScreen SHALL indicate for each Proposal which engine produced it (RulesEngine or AI), including when the AI is unavailable and the RulesEngine result is used.

### Requirement 7: Stitched Result Preview

**User Story:** As a data analyst, I want to see the joined result after approval, so that I can confirm the stitching worked.

#### Acceptance Criteria

1. WHEN a StitchPlan containing approved MatchProposals is applied, THE StitchingEngine SHALL create a StitchedTable that joins the matched tables on the approved column correspondences using a LEFT JOIN chain.
2. THE StitchingEngine SHALL default the AnchorTable to the LoadedTable with the most rows, THE ApprovalScreen SHALL allow the user to change the AnchorTable, and THE ApprovalScreen SHALL display the join type (LEFT JOIN) and the selected AnchorTable.
3. WHEN three or more tables are joined, THE StitchingEngine SHALL join them sequentially in descending order of approved MatchProposal ConfidenceScore, beginning from the AnchorTable.
4. FOR each pair of joined tables, THE StitchingEngine SHALL use the highest-confidence approved MatchProposal as the join key by default, and THE ApprovalScreen SHALL allow the user to choose a different approved match as the join key for that pair.
5. THE StitchingEngine SHALL treat approved matches that are not the join key as same-meaning columns rather than join keys.
6. THE StitchingEngine SHALL include a matched key column once in the StitchedTable, using the AnchorTable's column name.
7. THE StitchingEngine SHALL build the StitchedTable from the cleaned copies for any cleaning the user approved.
8. THE StitchingEngine SHALL compare join keys after applying approved cleaning to those columns, so that keys are matched using their trimmed, case-normalized values.
9. WHERE a join produces a many-to-many correspondence, THE StitchingEngine SHALL allow it but THE ApprovalScreen SHALL display a warning showing the row count before and after the join and SHALL allow the user to cancel the join.
10. WHEN a column name in the StitchedTable would collide with another column from a different source table, THE StitchingEngine SHALL prefix the colliding column name with its source table name.
11. WHEN a StitchedTable is created, THE FrankenData SHALL display it using the existing TablePreview (first 20 rows, column names, inferred ColumnTypes, and row count).
12. THE StitchedTable SHALL be created without altering or destroying any original LoadedTable.

### Requirement 8: Mismatched Demo Dataset

**User Story:** As a judge or first-time user, I want a built-in set of mismatched files, so that I can see the stitching feature work immediately.

#### Acceptance Criteria

1. THE FrankenData SHALL add a second demo dataset of two or more mismatched files to the existing demo loader, bundled so that loading requires no network access.
2. THE second demo dataset SHALL describe the same entities across its files using different column headers, so that cross-table matching has something to propose.
3. THE second demo dataset SHALL contain inconsistent category spellings and some duplicate rows, so that cleaning proposals have something to propose.
4. WHEN the user loads the second demo dataset, THE FrankenData SHALL route it through the same intake and stitching pipeline used for dropped files.
5. WHEN the second demo dataset is loaded, THE StitchingEngine SHALL produce its Proposals in under 2 seconds without freezing the UI.

### Requirement 9: Lab-Themed Stitching Table (Presentation Only)

**User Story:** As a participant, I want the proposals to feel like a mad-scientist "stitching table", so that the feature is engaging and on-theme.

#### Acceptance Criteria

1. THE ApprovalScreen SHALL apply the existing spooky mad-scientist lab theme, presenting the proposals as a "stitching table".
2. WHILE the lab theme is applied, THE ApprovalScreen SHALL render body text with a contrast ratio of at least 4.5:1 against the themed background.
3. THE lab theme SHALL be presentation-only and SHALL NOT change the StitchingEngine logic or the Proposals it produces.

### Requirement 10: Property-Based Tests for the Deterministic Engine

**User Story:** As a developer, I want property-based tests covering the deterministic engine and the AI fallback, so that the core stitching logic is robust across varied inputs.

#### Acceptance Criteria

1. THE TestSuite SHALL include a property-based test verifying matching symmetry: for any two LoadedTables, the MatchProposals for (A, B) are equivalent to those for (B, A) with identical ConfidenceScores.
2. THE TestSuite SHALL include a property-based test verifying that every ConfidenceScore is within the inclusive range 0 to 1.
3. THE TestSuite SHALL include a property-based test verifying cleaning idempotence: applying a CleaningProposal twice yields the same result as applying it once.
4. THE TestSuite SHALL include a property-based test verifying that applying a StitchPlan never mutates any original LoadedTable.
5. THE TestSuite SHALL include a property-based test verifying that undo restores the state present immediately before the StitchPlan was applied.
6. THE TestSuite SHALL include a property-based test verifying that when the AiProvider throws or fails, the StitchingEngine returns the RulesEngine result and does not propagate the failure.
7. THE TestSuite SHALL exercise the AiProvider only through a fake implementation, with no real network calls.
8. THE TestSuite SHALL include a property-based test verifying that a LEFT JOIN StitchedTable never returns fewer rows than its AnchorTable.
9. THE TestSuite SHALL include a property-based test verifying that no MatchProposal with a ConfidenceScore below MATCH_DISPLAY_THRESHOLD is ever displayed.
10. THE TestSuite SHALL include a property-based test verifying that "approve all high-confidence" approves exactly the Proposals whose ConfidenceScore is at or above HIGH_CONFIDENCE_THRESHOLD, and no others.
11. THE TestSuite SHALL include a property-based test verifying that the RulesEngine output is identical across repeated runs on the same input.
12. THE TestSuite SHALL include a property-based test verifying that AI responses with out-of-range ConfidenceScores or references to unknown tables or columns never change the StitchingEngine output.

### Requirement 11: AiProxy and AI Response Safety

**User Story:** As a security-conscious developer, I want the AI proxy and the client's handling of AI responses to be hardened, so that the AI enhancement cannot leak data, overspend, corrupt proposals, or inject markup.

#### Acceptance Criteria

1. THE AiProxy SHALL enforce a per-client rate limit of AI_PROXY_PER_CLIENT_LIMIT (20 requests per hour), a global daily spending cap of AI_PROXY_DAILY_REQUEST_CAP (500 requests per day), a maximum request payload size of AI_PROXY_MAX_PAYLOAD_BYTES (20480 bytes), and an allowed-origin check, and SHALL return a distinct status when any of these limits is hit.
2. THE AiProxy SHALL NOT log SampleValues.
3. THE client SHALL apply a request timeout of AI_REQUEST_TIMEOUT_MS (default 8000 ms) to each AiProxy request and SHALL treat a timeout as a failure.
4. THE client SHALL validate every AI response: ConfidenceScores outside the inclusive range 0 to 1 SHALL be clamped or rejected, references to unknown tables or columns SHALL be ignored, and a malformed response SHALL be treated as a failure that triggers the RulesEngine fallback.
5. THE AI SHALL only adjust the ConfidenceScore and reason of existing MatchProposals, and SHALL NOT create, apply, or approve any Proposal.
6. THE FrankenData SHALL treat cell values sent to the AI as untrusted data and SHALL render all AI-provided text as plain text, never as markup.
