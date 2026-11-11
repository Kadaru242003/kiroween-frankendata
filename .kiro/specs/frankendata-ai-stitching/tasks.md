# Implementation Plan: FrankenData AI Stitching and Cleaning

## Overview

Feature 2 adds the "stitching" stage to FrankenData: when two or more tables are loaded, a deterministic offline engine proposes cross-table column matches and per-table cleanups, the user approves/rejects/edits each proposal on a mad-scientist "stitching table" approval screen, and applying creates new `stitch_<n>_*` DuckDB tables (never touching originals) with full undo. A stitched LEFT-JOIN result is shown via the existing `TablePreview`. An optional LLM enhancement behind an `AiProvider` interface (reached only through a serverless `/api/ai` proxy) may refine match scores and reasons, but the app always works offline on the rules engine alone.

This plan is ordered so the **app works end to end on the rules engine as early as possible**. The AI proxy/provider is built last and is strictly additive — removing it leaves a fully functional offline app. All core logic (`SampleReader`, scoring, cleaning rules, `StitchApplier`, validation) is framework-agnostic per `.kiro/steering/structure.md` and is unit/property tested without React or the network where possible.

**Conventions (consistent with Feature 1):**
- Property tests use `fast-check` with ≥100 iterations per property, in their own dedicated test files so they can run in parallel.
- The 13 correctness properties (Properties 1–13) and the golden-example match test are **required** (no `*`).
- Only genuine polish items are optional (`*`).
- Each property-test sub-task annotates its design property and the requirement(s) it validates.
- Checkpoints run `npm test` (already `vitest --run`), `npm run lint`, and `npm run build`.

## Tasks

- [ ] 1. Prerequisite: add `loadId` to Feature 1 `LoadedTable` and store
  - Add a monotonically increasing `loadId: number` to the `LoadedTable` interface in `src/core/types.ts`
  - Assign the next `loadId` when a table is added to `IntakeStore` (sequence per session, never reused), so a re-dropped file with the same name and row count still gets a fresh id
  - Update `DuckDBService.createTable` / the intake pipeline so produced `LoadedTable`s carry the id
  - Update all existing test fixtures and code that construct `LoadedTable` so the project type-checks (`npm run build` / `tsc` passes)
  - Write a unit test: re-adding a same-name/same-rowcount table yields a strictly greater `loadId`
  - _Design: Staleness; Requirements 3.8_

- [ ] 2. Deployment config (agent-doable; you run the actual deploy by hand)
  - Add `vercel.json` (SPA rewrites, correct `Content-Type`/caching headers for `.wasm`)
  - If you report the 100 MB static limit is tight, adjust the build config to ship **only the `eh` bundle**
  - Write a short `DEPLOY.md` covering the Vercel setup, the WASM-size caveat, and the manual steps
  - _Note: this task produces config + docs only. The actual deploy and 100 MB verification are in "Manual Steps Required From You" and are done by you before any tasks run._
  - _Design: Serverless Host; Requirements 11 (hosting constraints)_

- [ ] 3. Stitching core types and named constants
  - Create `src/core/stitching/types.ts` (or `src/core/stitch-types.ts`) defining: `ColumnRef`, `ProposalSource`, `MatchProposal`, `CleaningKind`, `CleaningProposal`, `Proposal`, `ApprovalDecision`, `StitchPlan`, `StitchedTable`, `UndoStep`, `SampleValue`, `TableSample`, `ProposalSet`, `RulesEngine`, `StitchController`, and the `AiProvider`/`AiRequest`/`AiResponse`/`AiRefinement`/`AiSampleColumn`/`AiCandidateMatch` interfaces, exactly as in the design
  - Define named constants: `MATCH_DISPLAY_THRESHOLD = 0.5`, `HIGH_CONFIDENCE_THRESHOLD = 0.85`, `AI_REQUEST_TIMEOUT_MS = 8000`, `MAX_SAMPLE_VALUES_PER_COLUMN = 200`, `AI_PROXY_PER_CLIENT_LIMIT = 20`, `AI_PROXY_DAILY_REQUEST_CAP = 500`, `AI_PROXY_MAX_PAYLOAD_BYTES = 20480`
  - Define the `ColumnType` compatibility matrix (with hard-zero entries)
  - _Design: Module Interfaces, Named Constants, Type compatibility matrix; Requirements 1, 2, 3, 4, 6, 11_

- [ ] 4. SampleReader (deterministic, frequency-carrying)
  - Implement `SampleReader` reading, per column, `SELECT col AS value, COUNT(*) AS n FROM t GROUP BY col ORDER BY n DESC, value ASC LIMIT 200` via `DuckDBService.query`
  - Return `TableSample`s with `SampleValue[]` (value + count), NULLs excluded from matching sets, applying the global tie-break (count desc, then value asc)
  - _Design: SampleReader query (determinism); Requirements 2.9, 5.2_

- [ ] 5. Fuzzy name similarity
  - Implement deterministic name normalization (NFKC, lowercase, token split on non-alphanumeric + camel/snake boundaries)
  - Implement `nameSim(a,b)` = `0.6·Jaccard(tokens) + 0.4·(1 − normalizedLevenshtein(joined))`, clamped to `[0,1]`, symmetric
  - _Design: Name normalization, nameSim; Requirements 1.2, 1.4_

- [ ] 6. Match scoring with hard gates and damping
  - Implement `typeCompat` (matrix lookup), `valueOverlap` = overlap-coefficient over normalized sample sets × `min(1, min(|SA|,|SB|)/10)` small-set damping
  - Apply hard gates before scoring (symmetric): type-incompatible, **either column boolean**, `nameSim < 0.2`
  - Compute `confidence = 0.50·nameSim + 0.20·typeCompat + 0.30·valueOverlap`; keep the full set internally, expose only `≥ MATCH_DISPLAY_THRESHOLD`
  - Implement `RulesEngine.match(tables)` producing symmetric, deduplicated `MatchProposal`s with one-line reasons and `components`
  - _Design: Hard gates, valueOverlap damping, Final confidence; Requirements 1.1–1.6, 5.2, 5.3_

- [ ] 7. Cleaning rules engine
  - Implement `RulesEngine.clean(tables)` producing `CleaningProposal`s:
    - whitespace (trim + collapse only, never case) and case-only (only when same value appears in differing casings → most-frequent form)
    - category-standardize via value folding (case/whitespace/punctuation) + equal-folded clustering + optional normalized-Levenshtein ≥ 0.9 merge; canonical = most-frequent surface form (ties lexicographic); build `variantMap`
    - duplicate-rows flag; outliers flag for number columns only — the proposal (and its before/after count) comes from a **SQL count over the full column** using the same `quantile_cont` Tukey fences as apply, not from the bounded samples
  - Each proposal carries before/after + one-line reason; all transforms idempotent by construction
  - _Design: Cleaning rules; Requirements 2.1–2.8_

- [ ] 8. StitchApplier: cleaned copies, join chain, undo
  - [ ] 8.1 Cleaned copies (all identifiers via `quoteIdent`, all literals via `quoteString`)
    - Create `stitch_<n>_clean_<name>` via explicit typed DDL: whitespace (trim/collapse) and case `CASE` maps, category `CASE` maps to canonical literals, outliers `is_outlier BOOLEAN` via `quantile_cont` Tukey fences over the full column, duplicate-rows keep-first via `row_number() OVER (PARTITION BY <normalized exprs> ORDER BY rowid)=1`
    - _Design: Apply (cleaned copies), escaping; Requirements 2.4, 2.5, 2.6, 4.1_
  - [ ] 8.2 Join chain
    - Create `stitch_<n>_result`: anchor = most rows (overridable), LEFT JOIN remaining tables in descending approved-match confidence; default join key = highest-confidence approved match per pair; non-key matches as same-meaning columns; key column once using anchor's name; collision → prefix source table name; keys compared post-cleaning
    - _Design: Apply (join chain); Requirements 7.1, 7.3, 7.4, 7.5, 7.6, 7.8, 7.10_
  - [ ] 8.3 Apply counter, undo, and fan-out reporting
    - Per-session apply counter `n` embedded in every created name; record `UndoStep { createdTableNames }`; `undo()` drops exactly those tables; compute and return the many-to-many before/after row counts for the UI to warn/cancel
    - _Design: Table naming, Undo; Requirements 4.1, 4.2, 4.3, 4.4, 7.9, 7.12_

- [ ] 9. StitchController and StitchStore (rules-only wiring)
  - Implement `StitchStore` (session-only: `ProposalSet`, `ApprovalDecision`s, active `StitchPlan`, `StitchedTable`, pending `UndoStep`)
  - Implement `StitchController.computeProposals()` (SampleReader → RulesEngine; AI left as a no-op injection point for now), `applyPlan()`, `undo()`
  - Implement `datasetVersion` from sorted `loadId`s; on change, discard proposals/decisions, recompute, flag "recomputed" for the UI
  - Build the `StitchedTable` descriptor from `information_schema` + `getRowCount`
  - _Design: StitchController, ProposalSet lifecycle/staleness; Requirements 3.4, 3.5, 3.8, 5.1, 5.4, 7.11_

- [ ] 10. Required property tests — matching and scoring
  - [ ] 10.1 **Property 1: Matching symmetry** — _Validates: 1.4, 5.2_
  - [ ] 10.2 **Property 2: Confidence score bounds** — _Validates: 1.3, 10.2, 11.4_
  - [ ] 10.3 **Property 3: Type-incompatibility gate** (incl. boolean exclusion) — _Validates: 1.5_
  - [ ] 10.4 **Property 11: Rules-engine determinism** — _Validates: 5.2, 10.11_
  - [ ] 10.5 **Property 9: Below-threshold proposals never displayed** — _Validates: 1.6, 10.9_

- [ ] 11. Required property tests — cleaning and apply/undo
  - [ ] 11.1 **Property 4: Cleaning idempotence** — _Validates: 2.8, 10.3_
  - [ ] 11.2 **Property 5: Apply never mutates originals** (DuckDB-backed) — _Validates: 4.1, 7.12, 10.4_
  - [ ] 11.3 **Property 6: Undo restores pre-apply state** (DuckDB-backed) — _Validates: 4.3, 10.5_
  - [ ] 11.4 **Property 8: LEFT JOIN row-count floor** (DuckDB-backed) — _Validates: 7.1, 10.8_
  - [ ] 11.5 **Property 13: Generated SQL is injection-safe under adversarial values** — _Validates: 4.1, escaping invariant_

- [ ] 12. Checkpoint — rules engine green
  - Run `npm test`, `npm run lint`, `npm run build`; fix any failures before proceeding

- [ ] 13. Approval screen and stitching-table UI
  - Implement `ApprovalScreen` listing match (≥ threshold) and cleaning proposals as before/after diffs, with per-proposal approve/reject/edit and "approve all high-confidence" (uses `HIGH_CONFIDENCE_THRESHOLD`)
  - Implement `MatchDiff`/`CleaningDiff`: edit a match = re-pair to a different column in the other table; edit a category proposal = change canonical value; render all proposal/AI text as plain text
  - Per-proposal engine badge (`rules`/`ai`); assemble `StitchPlan` applied only on confirm
  - Mount the `ApprovalScreen` in `App` with a visible "Stitch" entry point **only when two or more tables are loaded**; hide it otherwise
  - _Design: UI Layer, edit semantics; Requirements 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 6.8_

- [ ] 14. Join controls and stitched-result preview
  - Implement `JoinControls`: show join type (LEFT JOIN) + anchor, allow changing anchor and picking a different approved match as the per-pair key; show many-to-many warning with before/after row counts and a cancel action
  - On apply, create the stitched table and render it with the existing `TablePreview`; wire undo control
  - _Design: JoinControls, Apply; Requirements 7.2, 7.4, 7.9, 7.11_

- [ ] 15. Required property/UI tests — approval behavior
  - [ ] 15.1 **Property 10: Approve-all-high-confidence selects exactly the ≥ threshold set** — _Validates: 3.3, 10.10_
  - [ ] 15.2 Staleness integration test: changing the `LoadedTable` set discards decisions, recomputes, and surfaces the notice — _Validates: 3.8_

- [ ] 16. Second mismatched demo dataset
  - Add a second bundled demo dataset (≥ 2 mismatched files) to the existing `DemoDataLoader`: same entities with different headers, inconsistent category spellings, and some duplicate rows; no network access
  - Route it through the existing intake + stitching pipeline
  - _Design: Golden example, demo; Requirements 8.1–8.4_

- [ ] 17. Golden example match test (required)
  - Load the three Feature 1 demo files **plus** the new mismatched dataset through the real pipeline; assert expected matches present (e.g. `monsters."Monster Name"` ↔ `experiments.name`) and known bogus ones absent (e.g. `sedated` ↔ `hazardous`)
  - Assert proposals are produced in under 2 seconds
  - _Design: Golden example (regression anchor); Requirements 1.2, 1.5, 8.5_

- [ ] 18. Checkpoint — rules-only app works end to end
  - Run `npm test`, `npm run lint`, `npm run build`; manually confirm load → propose → approve → apply → preview → undo all work offline with the demo dataset

- [ ] 19. AiProvider interface, payload budgeting, and client validation
  - Implement `ProxyAiProvider` (fetch `/api/ai`, `AI_REQUEST_TIMEOUT_MS` timeout) and a `FakeAiProvider` for tests
  - Implement client payload budgeting: only candidates ≥ `MATCH_DISPLAY_THRESHOLD`, ≤ 5 samples/column × 40 chars, ≤ 40 columns, ≤ 30 candidates (drop lowest-confidence first); skip the call silently if over `AI_PROXY_MAX_PAYLOAD_BYTES` or if `VITE_AI_ENABLED` is off
  - Implement `validateAiResponse`: shape check, known+eligible ids only, duplicate id → first wins, bounded adjustment `clamp(rule + clamp(ai−rule, ±0.2), 0, 1)`, reason ≤ 200 chars, scope to score/reason only, plain-text
  - Wire into `StitchController` so any failure/absence falls back to the rules result with `aiUsed=false`
  - _Design: AiProvider, payload budgeting, score bounding, validation steps, dev-mode flag; Requirements 6.1–6.8, 11.4, 11.5, 11.6_

- [ ] 20. Required property tests — AI refinement and fallback
  - [ ] 20.1 **Property 7: AI failure falls back to rules** (FakeAiProvider throws/times out) — _Validates: 6.5, 6.6, 10.6_
  - [ ] 20.2 **Property 12: AI refinement is bounded, eligible-only, ignores invalid input** (bounds ±0.2, demote-not-resurrect, out-of-range/overlong/duplicate-id handling) — _Validates: 11.4, 11.5, 10.12, 6.5, 6.6_

- [ ] 21. Serverless AiProxy at `/api/ai` (env-driven provider/model)
  - Implement the Vercel Function: request-schema validation (reject unknown fields/oversized arrays), payload-size check (`AI_PROXY_MAX_PAYLOAD_BYTES`), Origin courtesy check, per-client limit (IP-hash key) + global daily cap via Upstash Redis, fail-closed to the "unavailable" status if Redis is unreachable
  - Drive **provider and model from environment variables** (no hard-coded model); build the server-side prompt (names/values declared untrusted, JSON-only, low `max_tokens`); never log `SampleValues`
  - Proxy unit tests over the handler using the pinned constants and a mocked upstream/Redis (no real network)
  - _Design: Proxy responsibilities, LLM provider/cost, fail-closed; Requirements 6.3, 11.1, 11.2_

- [ ] 22. Proxy route config and env documentation (agent-doable)
  - Add the `/api/ai` route config to `vercel.json` / project structure so the function is wired
  - Add `.env.example` listing **every** variable: `AI_PROVIDER`, `AI_MODEL`, the LLM provider API key (e.g. `OPENAI_API_KEY`), `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `IP_HASH_SALT`, `VITE_AI_ENABLED`
  - Extend `DEPLOY.md` with the proxy setup and the env-var meanings
  - _Note: config + docs only. Provisioning Upstash, setting the env vars, the provider-side budget limit, and the `/api/ai` end-to-end smoke test are in "Manual Steps Required From You" and are done by you._
  - _Design: Serverless Host, env-driven provider; Requirements 6.3, 11.1_

- [ ] 23. Kiro feature showcase: hook + steering update
  - Add a **manually triggered** `.kiro/hooks/<id>.json` hook (`userTriggered`, e.g. "Run test suite" → `npm test`) via the hook tooling, so it never fires automatically or consumes credits on its own
  - Update steering docs (`.kiro/steering/structure.md` and `tech.md`) to describe the stitching module layout, the `/api/ai` proxy + env vars, and the deterministic-engine/offline-fallback rule
  - _Note: showcases Kiro hooks + steering_

- [ ] 24. Lab "stitching table" theme polish
  - [ ]* 24.1 Style the `ApprovalScreen`/diffs as the mad-scientist stitching table (presentation only; no logic change)
  - [ ]* 24.2 Contrast test (≥ 4.5:1) over the theme token pairs used by the approval screen
  - _Design: Visual theme; Requirements 9.1, 9.2, 9.3_

- [ ] 25. Final checkpoint
  - Run `npm test`, `npm run lint`, `npm run build`; confirm all 13 properties + the golden test pass and the deployed app works both with AI on and with `VITE_AI_ENABLED` off

## Notes

- Tasks marked `*` are optional polish (theme styling, contrast test). Everything else — including all 13 property tests and the golden example test — is required.
- Rules-only end-to-end (tasks 1–18) comes before any AI work (19–22), so the app is fully functional offline before the proxy exists and remains so if AI is removed.
- DuckDB-backed property tests (Properties 5, 6, 8, 13) use the in-memory instance with small generated tables, matching the Feature 1 pattern; pure-logic properties run without DuckDB or the network.
- The `AiProvider` is always a `FakeAiProvider` in tests — no real network calls.
- Checkpoints: task 12 (after rules engine), task 18 (after rules-only UI/demo), task 25 (final) — each runs `npm test` + `npm run lint` + `npm run build`.

## Execution Batches

Tasks are executed in batches with a **credit check after each batch** (stop, report actual usage, confirm before continuing):

- **Task 1** runs first on its own (the `loadId` prerequisite; must type-check green before anything else).
- **Task 2 is skipped by the agent** — you do the deployment by hand (the agent-doable config/docs part of task 2 can be folded in whenever convenient, but the deploy/verify is yours).
- **Batch 1 — tasks 3–12:** stitching types/constants through the rules engine and its required property tests, ending at the task-12 checkpoint. → credit check.
- **Batch 2 — tasks 13–18:** approval/join UI, approval/staleness tests, second demo dataset, golden test, ending at the task-18 rules-only end-to-end checkpoint. → credit check.
- **Batch 3 — tasks 19–25:** AiProvider + validation, AI property tests, serverless proxy, proxy/env config, hook + steering, optional theme polish, final checkpoint. → credit check.

## Manual Steps Required From You

Do these yourself (no agent credits); the deployment is done **before** running the task batches:

1. **Vercel deploy + WASM verification (relates to task 2):** create/log in to Vercel, import the repo, set build command `npm run build` / output `dist`, run the first deploy, and confirm the ~35–39 MB WASM files are served and fit under the 100 MB Hobby limit. If it is tight, tell the agent so task 2 ships only the `eh` bundle.
2. **Upstash + env vars (relates to task 22):** provision Upstash Redis via the Vercel Marketplace, then set by hand: `AI_PROVIDER`, `AI_MODEL`, the LLM provider API key (e.g. `OPENAI_API_KEY`), `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `IP_HASH_SALT`, `VITE_AI_ENABLED`; set the provider-side hard monthly budget.
3. **Proxy end-to-end smoke test (relates to task 22):** after deploying, hit `/api/ai` to confirm it works, and confirm rules-only still works with `VITE_AI_ENABLED` off.

## Credit Cost Estimate

Rough estimate for executing **only the required tasks** (excludes the optional `*` theme-polish sub-tasks in task 24; excludes your manual Vercel/Upstash steps, which consume no agent credits):

| Phase | Tasks | Relative size |
|-------|-------|---------------|
| Prereq + deploy config | 1, 2 (config side) | small |
| Core types + constants | 3 | small |
| Rules engine (sampler, scoring, cleaning, applier, controller) | 4–9 | large |
| Required property tests (rules) | 10, 11 | large |
| UI (approval, join controls, previews) | 13, 14 | medium–large |
| Required approval/staleness tests | 15 | small–medium |
| Demo dataset + golden test | 16, 17 | medium |
| AiProvider + validation + proxy | 19, 21 | medium–large |
| Required AI property tests | 20 | medium |
| Deploy/env wiring + hook/steering | 22, 23 | small |
| Checkpoints (test/lint/build × 3) | 12, 18, 25 | small each, plus any fix-ups |

**Overall: a medium-to-large feature — roughly on the order of the Feature 1 build.** The dominant costs are the rules engine (4–9), its property tests (10–11), and the UI (13–14). DuckDB-backed property tests (5, 6, 8, 13) and the checkpoints tend to cost more than their size suggests because of iterate-until-green cycles.

This is a planning estimate, not a quote. Actual credit usage depends on how many debug/verify iterations each task needs (property-test failures and build/lint fix-ups are the usual swing factor), file sizes at implementation time, and whether the optional polish tasks are included. I can give a tighter per-task estimate before starting any specific task if that's useful.
