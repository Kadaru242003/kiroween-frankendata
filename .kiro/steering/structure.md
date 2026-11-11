# Structure

## Folder layout

- `src/core/` — pure, framework-agnostic TypeScript: file-type detection, size check, CSV/XLSX parsers, type inference, value coercion, name sanitization, predicates, the intake controller, demo-data loader, and shared types.
- `src/db/` — the DuckDB-WASM service (single in-memory instance, typed table creation, insertion, string fallback, preview/count queries).
- `src/state/` — session state (the intake store holding loaded tables and errors for the current session only).
- `src/components/` — React UI (DropZone, TablePreview, ErrorDisplay, DemoDataControl) with their `.css`.
- `src/theme/` — theme color tokens.

### Stitching module layout (Feature 2)

- `src/core/stitching/` — framework-agnostic stitching engine:
  - `types.ts` — shared stitching types, named constants, and the `ColumnType` compatibility matrix.
  - `sample-reader.ts` — deterministic, frequency-carrying column sampler over `DuckDBService.query`.
  - `name-similarity.ts` — name normalization + the symmetric `nameSim` fuzzy name score.
  - `match-scoring.ts` — type/value-overlap scoring with hard gates and damping; the `RulesEngine.match` matcher.
  - `rules-engine.ts` — the deterministic engine wiring match + clean into a `ProposalSet`.
  - `cleaning-rules.ts` — per-table cleaning proposals (whitespace, case, category-standardize, duplicates, outliers), all idempotent.
  - `stitch-applier.ts` — applies an approved plan: cleaned `stitch_<n>_clean_*` copies, the LEFT-JOIN result table, and undo (drops exactly the created tables; originals untouched). All SQL escaped via `sql-escape.ts`.
  - `stitch-controller.ts` — orchestrates SampleReader → RulesEngine → optional AI; `computeProposals` / `applyPlan` / `undo`; `datasetVersion` staleness handling.
  - `stitch-store.ts` — session-only state (proposal set, decisions, active plan, stitched table, pending undo).
  - `plan-assembly.ts` — assembles a `StitchPlan` from approval decisions.
  - `ai-provider.ts` — `ProxyAiProvider` (talks to `/api/ai`) and `FakeAiProvider` for tests, behind the `AiProvider` interface.
  - `ai-budget.ts` — client-side payload budgeting (candidate/sample/column caps, size limit).
  - `ai-validation.ts` — validates/bounds the AI response (eligible-only, ±0.2 clamp, plain-text, reason length).
  - `ai-proxy.ts` — the framework-agnostic proxy request handler (validation, rate limits, fail-closed), unit-tested with mocked Redis + upstream.
- `src/components/stitching/` — stitching React UI:
  - `ApprovalScreen` — lists match/cleaning proposals with per-proposal approve/reject/edit and "approve all high-confidence".
  - `MatchDiff` / `CleaningDiff` — before/after diff rows for match and cleaning proposals (all proposal/AI text rendered as plain text).
  - `JoinControls` — join type/anchor controls and the many-to-many row-count warning.
  - `EngineBadge` — per-proposal `rules`/`ai` source badge.
  - `StitchEntryPoint` — the "Stitch" entry point, shown only when two or more tables are loaded.
- `api/ai.ts` — the Vercel serverless function (the only host/`process.env`/network touch point); delegates all logic to `ai-proxy.ts`.

## Architecture rule

Core logic stays framework-agnostic. Parsing, type inference, coercion, name sanitization, and DuckDB interaction live in plain TypeScript modules (`src/core`, `src/db`, `src/state`) that can be unit- and property-tested without rendering React or the DOM. React sits only at the edges in `src/components`. UI components forward files/events into the core pipeline and render its results; they do not own parsing or typing logic. The same rule holds for stitching: the engine, applier, controller, and AI validation live in `src/core/stitching` and are tested without React or the network.

## Deterministic-engine / offline-fallback rule

Every stitching proposal (matches and cleanups) is produced by the deterministic rules engine. The optional LLM, reached only through the `/api/ai` proxy, may at most nudge a match score by ±0.2 and only for candidates the rules engine already made visible — it never introduces, resurrects, or removes proposals. Any AI failure, timeout, oversized payload, or `VITE_AI_ENABLED` being off falls back to the rules-only result (`aiUsed=false`). The app always works fully offline on the rules engine alone; removing the proxy/provider leaves a fully functional app.

## Test naming conventions

Tests live next to the module they cover.

- `*.property.test.ts` — property-based tests (fast-check), e.g. `type-inference.numbers.property.test.ts`. The infix names the specific property or facet under test.
- `*.smoke.test.ts` / `*.smoke.test.tsx` — minimal end-to-end sanity checks.
- `*.test.ts` / `*.test.tsx` — example-based unit tests.

Each property test references its design property by tag: **Feature: frankendata-file-intake, Property {n}: {title}**.
