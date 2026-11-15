# Implementation Plan: FrankenData Smarter Ask

## Overview

Core first (thread, chart choice, reset lock, proxy and controller changes), then the UI (store, cards, line chart, panel, Ask about this, reset lock wiring), then Playwright slow mode, then property tests and final checks, per `.kiro/steering/structure.md`.

**Conventions:** property tests use `fast-check`, one invariant per file, tagged in the header comment. No change to the SQL validator, proxy limits, or error codes. Every group ends with `npm run build`.

## Tasks

- [x] 1. Thread module
  - Create `src/core/chat/thread.ts`: constants, `ThreadTurn`, `toThreadTurn`, `toThread`, `fitRequestToCap`
  - Add `SqlRequest.thread?` and `temporalColumns?` on the ok outcome in `types.ts`
  - Unit tests; Property 1 and Property 2 tests
  - _Design: Data model, Request and budgeting; Requirements 1.1 to 1.4, 7.1, 7.2_
- [x] 2. Proxy thread support
  - Validate `thread` in `validateSqlRequestSchema`, include it in the prompt, update the chart and thread prompt lines
  - Unit tests (valid thread, each rejection, same codes, thread in the user prompt) and Property 5
  - _Design: Proxy changes; Requirements 1.5, 1.6, 7.5_
- [x] 3. Chart choice and controller
  - Create `src/core/chat/chart-choice.ts`; update the controller (`ask(question, thread)`, `temporalColumns`, line choice)
  - Unit tests, controller thread tests, Property 3
  - _Design: Chart choice, Controller; Requirements 1.3, 3.1 to 3.4, 3.7, 3.8, 7.3_
- [x] 4. Reset lock
  - Create `src/state/reset-lock.ts`; unit tests and Property 4
  - _Design: Reset lock; Requirements 5, 7.4_
- [x] 5. Checkpoint: `npm run build`, `npm run check:api`, the touched tests; commit
- [ ] 6. Store, line chart, thread cards
  - Extend `AskStore` (`turns`, `pushTurn`, `clearThread`); create `LineChart.tsx` and `ThreadCards.tsx` with CSS
  - Store tests, LineChart smoke test
  - _Design: Store and UI; Requirements 1.8, 1.9, 2, 3.5, 3.6_
- [ ] 7. Panel, New topic, focus, Ask about this
  - Update `AskTheLabPanel` (thread, New topic, focus, line chart, prefill); wire `App.tsx` (`askPrefill`, button through `renderActions`)
  - Smoke tests for thread cards, New topic, focus, line chart, prefill
  - _Design: Store and UI; Requirements 1, 2, 4_
- [ ] 8. Reset lock wiring
  - `disabled` props on `DropZone`, `DemoDataControl`, `ApplyRecipe`; App uses the lock and the "Resetting the lab..." status
  - Smoke tests for the disabled props and the status
  - _Design: Reset lock; Requirements 5_
- [ ] 9. Checkpoint: `npm run build`, `npm run check:api`, `npm run mcp:build`, touched tests; commit
- [ ] 10. Playwright slow mode and follow-up step
  - `E2E_SLOWMO` in `playwright.config.ts`; follow-up step with graceful skip
  - _Design: Playwright slow mode; Requirements 6_
- [ ] 11. Final checks and notes
  - Full `npm test`, `npm run build`, `npm run lint`, `npm run check:api`, `npm run mcp:build`, `npm run test:e2e`
  - README features, `NOTES.md`, commit
  - _Requirements: all_
