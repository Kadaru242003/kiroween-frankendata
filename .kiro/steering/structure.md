# Structure

## Folder layout

- `src/core/` — pure, framework-agnostic TypeScript: file-type detection, size check, CSV/XLSX parsers, type inference, value coercion, name sanitization, predicates, the intake controller, demo-data loader, and shared types.
- `src/db/` — the DuckDB-WASM service (single in-memory instance, typed table creation, insertion, string fallback, preview/count queries).
- `src/state/` — session state (the intake store holding loaded tables and errors for the current session only).
- `src/components/` — React UI (DropZone, TablePreview, ErrorDisplay, DemoDataControl) with their `.css`.
- `src/theme/` — theme color tokens.

## Architecture rule

Core logic stays framework-agnostic. Parsing, type inference, coercion, name sanitization, and DuckDB interaction live in plain TypeScript modules (`src/core`, `src/db`, `src/state`) that can be unit- and property-tested without rendering React or the DOM. React sits only at the edges in `src/components`. UI components forward files/events into the core pipeline and render its results; they do not own parsing or typing logic.

## Test naming conventions

Tests live next to the module they cover.

- `*.property.test.ts` — property-based tests (fast-check), e.g. `type-inference.numbers.property.test.ts`. The infix names the specific property or facet under test.
- `*.smoke.test.ts` / `*.smoke.test.tsx` — minimal end-to-end sanity checks.
- `*.test.ts` / `*.test.tsx` — example-based unit tests.

Each property test references its design property by tag: **Feature: frankendata-file-intake, Property {n}: {title}**.
