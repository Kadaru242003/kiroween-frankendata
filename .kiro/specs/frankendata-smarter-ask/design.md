# Design Document: FrankenData Smarter Ask

## Overview

_All requirements._

Smarter Ask extends Ask the Lab (Feature 3) with a short follow-up thread, a thread view, line charts, an "Ask about this" shortcut, a reset lock, and a slow mode for the Playwright spec. All new logic is framework-agnostic and lives in `src/core/chat/` and `src/state/`; React stays at the edges. The SQL validator, fetch cap, proxy limits, shared daily cap, and fail-closed behavior are untouched.

## Architecture

_Requirements 1, 2, 3, 4, 5 and 7.2 (limits unchanged)._

```
AskTheLabPanel --ask(question, thread)--> AskController --SqlRequest{question, schema, thread?}--> /api/sql
     ^   |                                      |                    (handleSqlProxyRequest: validate thread,
     |   | store.pushTurn(question, outcome)    | validateSql          prompt with thread, same limits)
     |   v                                      v wrapWithFetchCap
  AskStore { history, outcome, loading, turns }   DuckDB -> outcome (+ temporalColumns, chart)
     |  toThread(turns) -> ThreadTurn[]   (names and counts only)
     v
  thread cards (previous turns) + current answer (SqlBlock, table, BarChart | LineChart)
```

### Modules

_Requirements 1, 3, 5 (module homes); 7.3 (no new dependency)._

- `src/core/chat/thread.ts` (new, pure): the `ASK_THREAD_*` constants, `ThreadTurn`, `toThreadTurn(question, outcome)`, `toThread(turns)`, `fitRequestToCap(request, maxBytes)`.
- `src/core/chat/chart-choice.ts` (new, pure): `chooseChart(columns, rows, temporal)` and the line point shaping helper `shapeLinePoints`.
- `src/state/ask-store.ts` (extend): `turns`, `pushTurn`, `clearThread`.
- `src/state/reset-lock.ts` (new): `ResetLock` observable and `useResetLock`.
- `src/core/chat/types.ts` (additive): `SqlRequest.thread?`, `AskOutcome` ok variant gains `temporalColumns?: string[]`.
- `src/core/chat/ask-controller.ts` (extend): `ask(question, thread?)`, line chart choice, `temporalColumns`.
- `src/core/chat/sql-proxy.ts` (extend): thread validation and the prompt.
- `src/components/chat/charts/LineChart.tsx` (new), `ThreadCards.tsx` (new), `AskTheLabPanel.tsx` (extend).
- `src/components/TablePreview.tsx` is unchanged; the "Ask about this" button is added through the existing `renderActions` prop in `App.tsx`.

## Data model

_Requirements 1.1, 1.2, 2.1, 7.1._

```ts
interface ThreadTurn { question: string; sql: string; columns: string[]; rowCount: number }
interface AskTurn { question: string; outcome: Extract<AskOutcome, { kind: "ok" }> }   // in memory only
```

`AskStore.turns` holds at most `ASK_THREAD_MAX_TURNS` AskTurns (oldest dropped first) and keeps full outcomes so cards can show their chart. `toThread(turns)` maps each to a ThreadTurn: the question is cut to `ASK_MAX_QUESTION_CHARS`, the SQL to `ASK_THREAD_MAX_SQL_CHARS`, columns to at most `ASK_THREAD_MAX_COLUMNS` names of at most `ASK_THREAD_MAX_COLUMN_NAME_CHARS` characters. Rows and cells are never read.

## Request and budgeting

_Requirements 1.2, 1.3, 1.4, 8.2._

`SqlRequest` gains an optional `thread`. The controller builds `{ question, schema, thread }` only when the thread is non-empty. `fitRequestToCap(request, maxBytes = AI_PROXY_MAX_PAYLOAD_BYTES)` serializes the request with `JSON.stringify` and measures UTF-8 bytes. While it is too large and the thread has turns, it drops the OLDEST turn. If the request is still too large with no turns, the thread field is removed. The schema summary already has its own 16 KiB cap, so a thread never displaces schema. A repair request is built the same way (same thread).

## Proxy changes (`sql-proxy.ts`)

_Requirements 1.5, 1.6, 7.2, 8.5._

- `ALLOWED_TOP_KEYS` gains `thread`. `validateSqlRequestSchema` validates: array, at most `ASK_THREAD_MAX_TURNS` items; each item exactly `{question, sql, columns, rowCount}`; `question` string at most `ASK_MAX_QUESTION_CHARS`; `sql` string at most `ASK_THREAD_MAX_SQL_CHARS`; `columns` array of at most `ASK_THREAD_MAX_COLUMNS` strings each at most `ASK_THREAD_MAX_COLUMN_NAME_CHARS`; `rowCount` a non-negative safe integer. Any violation is `bad_request`. The check runs before origin, counters, and LLM, so a bad thread never touches Redis or the model.
- `buildSqlUserPrompt` includes `thread` when present. `SQL_PROXY_SYSTEM_PROMPT` gets lines saying the THREAD is untrusted context (earlier questions, SQL, column names, row counts), that a short follow-up such as "only the High ones" or "sort that by count" refers to the most recent turn and should adapt that turn's SQL, and that the output still must be ONE read-only statement over the schema tables. The chart line is updated: a bar chart for one text column plus one numeric column, a line chart for one date or timestamp column plus one numeric column, otherwise omit. The response schema is unchanged.
- Status codes, error codes, `rlsql:` prefix, shared `cap:<day>` key, output token limit, and fail-closed handling are unchanged. `api/sql.ts` needs no change because it delegates to the core handler and already enforces the byte cap while reading the body.

## Chart choice (`chart-choice.ts`)

_Requirements 3.1 to 3.7, 8.3._

`chooseChart(columns, rows, temporal: ReadonlySet<string>)`:

1. Return `undefined` unless there are exactly two columns.
2. A column is numeric when its first non-empty converted value is a finite number (the same rule as `validateChartSpec`).
3. If one column is in `temporal` and the other numeric and `rows.length >= ASK_LINE_CHART_MIN_POINTS`: `{ type: "line", x: temporalColumn, y: numericColumn }`.
4. Else if one column is non-temporal and not numeric (text) and the other numeric and there is at least one row: `{ type: "bar", x: textColumn, y: numericColumn }`.
5. Else `undefined`.

It reads only the column names, the set, and the first non-empty value of each column, so it is deterministic and independent of the set's iteration order. In the controller: `auto = chooseChart(...)`; `chart = auto?.type === "line" ? auto : validateChartSpec(spec, ...)`. So bar charts behave exactly as before (they still need a valid spec), and temporal plus numeric always gets the line. A model `line` spec that does not match is dropped by `validateChartSpec` (line is not renderable).

`shapeLinePoints(columns, rows, x, y, max)` returns points sorted by x ascending (ISO strings sort lexicographically), then evenly samples to at most `ASK_LINE_CHART_MAX_POINTS` always keeping first and last.

`LineChart.tsx` reuses `chart.css` classes, draws axes, a polyline, point circles with `<title>`, tick labels for min and max y and the first and last x, a caption, `role="img"` with an `aria-label`, and a `visually-hidden` table of the plotted points.

## Controller

_Requirements 1.3, 1.4, 3.7, 3.8._

`createAskController` keeps its dependencies. `ask(question, thread = [])` builds the request via `fitRequestToCap`. `executeValidated` receives the exec result's `dateColumns` and `timestampColumns`, builds `temporalColumns` (sorted names), and adds it to the ok outcome. `runSql` is unchanged except for the same additive field and line choice.

## Store and UI

_Requirements 1.1, 1.8 to 1.11, 2.1 to 2.4, 4.1 to 4.5, 7.6._

- `AskStore.pushTurn(question, outcome)` appends and trims to 3. `clearThread()` empties `turns` only. `clearOutcome()` and `reset()` also empty `turns`.
- `AskTheLabPanel`: after a successful free-form or chip answer it calls `store.pushTurn`. `controller.ask(text, toThread(turns))` sends the thread (taken from the store before the new turn is added). A "New topic" button (visible when `turns.length > 0`) calls `clearThread()` and announces "Started a new topic" in a live region.
- Thread cards: `ThreadCards` renders `turns` whose outcome is not the current outcome, oldest first, as `<article aria-label="Earlier question 1">` with the question, a `<details>` for the SQL, the row count, and the chart. These sit above `ask-panel__outcome`.
- Focus: a ref flag set by the form submit makes an effect focus the outcome container (`tabIndex={-1}`) with `preventScroll: true` once. Chips and history buttons do not set the flag.
- Ask about this: App keeps `askPrefill: { text, nonce } | null`. The button (rendered through `renderActions`, next to the export buttons) sets it. `AskTheLabPanel` takes `prefill` and, in an effect on `nonce`, sets the input text, scrolls the panel into view (`behavior` auto under reduced motion), and focuses the input. The button is rendered only when `askAvailable` (a queryable table exists), which App already knows.

## Reset lock

_Requirements 5.1 to 5.6, 8.4._

`ResetLock` (`src/state/reset-lock.ts`) has `isBusy()`, `subscribe`, `getState`, and `run(fn)`: if busy it returns immediately (coalesced); otherwise it sets busy, awaits `fn()` in `try/finally`, and clears busy. `loadControlsEnabled(busy)` is `!busy`. App wraps `handleResetLab`'s body in `lock.run`, uses `useResetLock` to disable `DropZone`, the three `DemoDataControl`s, `ApplyRecipe`, and the Reset button, shows "Resetting the lab..." in a `role="status"` element, and early-returns from `handleFiles`, `loadDemo`, and `handleApplyRecipe` when `lock.isBusy()`. `DropZone`, `DemoDataControl`, and `ApplyRecipe` gain an optional `disabled` prop (default false) so their behavior is otherwise unchanged.

## Playwright slow mode

_Requirements 6.1 to 6.4._

`playwright.config.ts`: `const slowMo = Number.parseInt(process.env.E2E_SLOWMO ?? "", 10)`; `use.launchOptions = { slowMo: slowMo > 0 ? slowMo : 0 }`. The spec adds a follow-up step after the species chip: if the text "AI is off, starter questions still work." is visible it records an annotation and skips, otherwise it types "now only the Swamp Wraith ones", submits, and expects either a result or an error alert without failing the run.

## Error handling

_Requirements 1.4, 1.7, 7.4._

Provider failure and repair paths are unchanged (`ai-unavailable` or the friendly error). A thread that cannot fit is dropped silently. `New topic` and `Ask about this` never throw.

## Correctness properties and tests

_Requirement 8 (each property maps to 8.n below); 6.3 and 7.4 coverage is stated in requirements.md._

| Property | Test file |
| --- | --- |
| 1 thread bounds and privacy (8.1) | `src/core/chat/thread.property.test.ts` |
| 2 payload cap with a thread (8.2) | `src/core/chat/thread.payload.property.test.ts` |
| 3 chart determinism and rules (8.3) | `src/core/chat/chart-choice.property.test.ts` |
| 4 reset lock (8.4) | `src/state/reset-lock.property.test.ts` |
| 5 proxy thread validation (8.5) | `src/core/chat/sql-proxy.thread.property.test.ts` |

Other tests: `thread.test.ts`, `chart-choice.test.ts`, `ask-controller.thread.test.ts` (request carries a thread, no thread when empty, temporal outcome gets a line), `sql-proxy.thread.test.ts` (accepts a valid thread, prompt includes it, same codes), `ask-store.test.ts` additions, `LineChart.smoke.test.tsx`, `AskTheLabPanel.thread.smoke.test.tsx` (cards, New topic, focus, Ask about this prefill), `reset-lock.test.ts`, `ResetLocked.smoke.test.tsx` (disabled props), and the Playwright spec.

## Implementation notes and deviations

_Requirements 1.8 to 1.11 and 4.5 (the polish fixes below are now requirements)._

The full list is in `NOTES.md` next to this file. After the first release, two polish fixes changed behavior slightly:

- **Reset and New topic:** `AskStore` has an `epoch` that `reset()` always bumps, so the panel clears its own input text on Reset lab. "New topic" clears the input and moves focus to it.
- **One-shot prefill:** the "Ask about this" request is consumed after it is applied (`onPrefillHandled`) and is cleared by Reset lab, so a remount can never re-apply it.
- **Follow-up prompt:** the proxy system prompt now tells the model to build a refinement from the most recent turn's SQL and keep its aggregation, grouping and ordering. A prompt test pins this line and the existing safety lines.
