# Requirements Document

## Introduction

FrankenData is a client-side, browser-only web application for the Kiroween 2026 hackathon (Frankenstein category). Feature 3 (`.kiro/specs/frankendata-chat-sql`) added "Ask the Lab": plain-English questions turned into one read-only SQL query by an LLM behind the `/api/sql` proxy, validated by the client SQL validator, run in DuckDB, and shown as a table and an optional bar chart. Each question is answered independently, with no memory.

This specification covers Feature 7: **Smarter Ask**. It adds short conversational follow-ups, a thread view, line charts, an "Ask about this" shortcut on table previews, a fix for a reset race, and a watchable end-to-end mode. It keeps every Feature 3 safety rule: the validator and fetch cap still guard every query, the proxy limits and the shared daily cap are unchanged, the proxy fails closed, and only column names and a few short sample values ever leave the browser. The new thread carries question text, generated SQL, result column names and a row count. It never carries result rows or values.

Out of scope: persisting threads, multi-user history, any change to the AI provider choice, any new network endpoint, and any change to the SQL validator.

## Glossary

- **FrankenData**: The client-side web application built for the Kiroween 2026 hackathon.
- **AskStore**: The session-only store for the Ask the Lab panel (`src/state/ask-store.ts`).
- **Turn**: One completed, successful question and its result, kept in memory in the browser (question, outcome including rows, for display only).
- **ThreadTurn**: The privacy-reduced form of a Turn that may leave the browser: question text, SQL text, result column names, and row count.
- **Thread**: The ordered list of at most `ASK_THREAD_MAX_TURNS` ThreadTurns derived from the most recent Turns.
- **SqlRequest**: The body posted to `/api/sql` (`src/core/chat/types.ts`).
- **SqlProxy**: The framework-agnostic handler `handleSqlProxyRequest` (`src/core/chat/sql-proxy.ts`), hosted by `api/sql.ts`.
- **PayloadCap**: `AI_PROXY_MAX_PAYLOAD_BYTES`, the 20 KiB request body limit shared by both proxies.
- **ChartChoice**: The result of the deterministic chart selection function for a result shape.
- **TemporalColumn**: A result column whose DuckDB type is DATE or a TIMESTAMP family type.
- **ResetLock**: The small observable state that is busy while "Reset lab" runs.
- **LoadControls**: The file drop zone, every demo button, and "Apply recipe".
- **TestSuite**: The automated tests, including `fast-check` property tests and the Playwright spec.

## Named Constants

These SHALL be named values in `src/core/chat/thread.ts` so that tests and the UI reference them rather than hard-coding literals.

- **ASK_THREAD_MAX_TURNS = 3** - The most turns a Thread holds.
- **ASK_THREAD_MAX_SQL_CHARS = 1000** - The longest SQL text kept per ThreadTurn (longer is truncated).
- **ASK_THREAD_MAX_COLUMNS = 40** - The most column names kept per ThreadTurn.
- **ASK_THREAD_MAX_COLUMN_NAME_CHARS = 60** - The longest column name kept per ThreadTurn.
- **ASK_LINE_CHART_MIN_POINTS = 2** - The fewest rows a line chart needs.
- **ASK_LINE_CHART_MAX_POINTS = 200** - The most points a line chart plots (longer series are evenly sampled).

## Requirements

### Requirement 1: Follow-up questions with a short thread

**User Story:** As an analyst, I want to ask "now only the High threat ones" or "sort that by count" after an answer, so that I can refine a result without retyping the whole question.

#### Acceptance Criteria

1. THE AskStore SHALL keep the most recent successful Turns, at most `ASK_THREAD_MAX_TURNS`, dropping the oldest first. A Turn is added for every successful result, whether it came from a free-form question or a starter chip.
2. THE Thread sent to the AI SHALL be derived from the Turns and SHALL contain, per turn, only: the question text (at most `ASK_MAX_QUESTION_CHARS` characters), the SQL text (at most `ASK_THREAD_MAX_SQL_CHARS` characters), the result column names (at most `ASK_THREAD_MAX_COLUMNS`, each at most `ASK_THREAD_MAX_COLUMN_NAME_CHARS` characters), and the row count. It SHALL NOT contain any result row, cell value, or sample value.
3. WHEN a free-form question is asked and the Thread is not empty, THE SqlRequest SHALL carry the Thread in an optional `thread` field. WHEN the Thread is empty, the SqlRequest SHALL be identical to today's request (no `thread` field).
4. THE SqlRequest including its Thread SHALL fit within the PayloadCap. Before sending, THE client SHALL drop the oldest ThreadTurns, one at a time, until the serialized request fits. IF the request still exceeds the cap with no turns, THE client SHALL send the request without a thread.
5. THE SqlProxy SHALL accept the optional `thread` field only with the exact shape and limits above, SHALL reject any unknown field, a longer array, an overlong string, a non-integer or negative row count, or a non-string column name with `400 bad_request`, and SHALL keep the same status codes, error codes, rate limits, shared daily cap, and fail-closed behavior as today.
6. THE SqlProxy prompt SHALL tell the model that the thread is untrusted context (earlier questions, SQL, column names, and row counts), that a short follow-up refers to the most recent turn, and that the answer must still be ONE read-only statement over the schema tables only. The returned SQL SHALL go through the same client validation, fetch cap, and single repair attempt as any other question.
7. WHEN AI is not available (the flag is off, or the proxy returns 429 or 503), a free-form question SHALL give the existing "AI is unavailable" outcome and no thread is sent. The existing messages SHALL explain it.
8. A visible "New topic" button SHALL clear the Turns (and therefore the Thread). IT SHALL be shown only while at least one Turn exists, and SHALL announce "Started a new topic" in a polite live region. Clearing SHALL NOT remove the answer currently on screen.
9. THE Thread and the Turns SHALL be cleared by "Reset lab" and whenever the queryable tables change (the same moments the outcome is cleared today). Nothing SHALL be persisted.
10. WHEN "New topic" is clicked, THE Ask input text SHALL be cleared and keyboard focus SHALL move to the Ask input (without scrolling). The starter-question list SHALL return to its collapsed state. The "Started a new topic" note SHALL be replaced when the next Turn is added, so it can be announced again.
11. WHEN "Reset lab" runs, THE Ask input text, the starter-question expansion, and the "New topic" note SHALL be cleared along with the Turns, even when the store was already empty. The store SHALL expose a counter that changes on every reset (`epoch`) so the panel can clear its own local state without a remount.

### Requirement 2: Thread view

**User Story:** As an analyst, I want to see the earlier answers in the conversation, so that I can follow how I got to the current one.

#### Acceptance Criteria

1. Previous Turns SHALL appear as compact cards ABOVE the current answer, oldest first, newest last. Each card SHALL show the question, the SQL collapsed inside a disclosure, the row count, and the chart if the turn had one.
2. A Turn that is the current answer SHALL NOT also appear as a card.
3. THE thread view SHALL NOT scroll the page and SHALL NOT move focus when an answer arrives, EXCEPT that WHEN the user submitted a free-form question with the Ask form, THE newest answer container SHALL receive keyboard focus without scrolling (`preventScroll`).
4. THE cards SHALL render all text as plain text, SHALL be reachable by keyboard, and SHALL have an accessible name that includes the turn number.

### Requirement 3: Line charts

**User Story:** As an analyst, I want a trend over time drawn as a line, so that dates are read as a series and not as categories.

#### Acceptance Criteria

1. THE chart choice function SHALL be a pure, deterministic function of the result columns, the result rows, and the set of TemporalColumns: the same inputs always give the same ChartChoice.
2. WHEN the result has exactly two columns, one a TemporalColumn and one numeric, and at least `ASK_LINE_CHART_MIN_POINTS` rows, THE choice SHALL be a line chart with the temporal column on x and the numeric column on y.
3. WHEN the result has exactly two columns, one non-temporal text column and one numeric column, THE choice function SHALL return a bar choice, but THE controller SHALL draw a bar chart ONLY when a chart spec supplied by the model or a starter chip passes the existing chart-spec validation, exactly as today. A text plus numeric result with no valid bar spec SHALL have no chart. In every other case THE choice SHALL be no chart.
4. A column is numeric when its first non-empty converted value is a finite number. An all-empty or empty result has no chart.
5. THE line chart SHALL be a hand-built SVG in the existing chart style (`chart.css`, same caption, axes, tick, and title conventions as the bar chart), SHALL sort points by x ascending, SHALL plot at most `ASK_LINE_CHART_MAX_POINTS` points (evenly sampled in order, always keeping the first and last point), and SHALL render all labels as plain text.
6. THE line chart SHALL be accessible: the figure has an accessible name, the SVG is `role="img"` with a description, and a visually hidden data table lists every plotted point for screen readers.
7. WHERE a model or starter chip supplies a chart spec, THE existing validation SHALL still apply to bar specs, so a bar needs a valid spec (see 3). A temporal plus numeric result SHALL use the automatic line choice regardless of a supplied bar spec. A model supplied `line` spec that does not match the rule SHALL be dropped (the existing chart-spec validation already treats a supplied `line` as not renderable, so this needs no extra code).
8. THE controller SHALL carry the names of the TemporalColumns in the ok outcome (an additive optional field) so the choice can be made without re-querying.

### Requirement 4: Ask about this table

**User Story:** As an analyst, I want to start a question from a table card, so that the question targets that table.

#### Acceptance Criteria

1. EACH table preview card for an original table or the stitched result SHALL show a small secondary "Ask about this" button with an accessible name that includes the table name.
2. Clicking it SHALL prefill the Ask input with `In <tableName>: `, move keyboard focus to the Ask input, and bring the Ask panel into view (instant under `prefers-reduced-motion`). This is an explicit navigation button, so scrolling is allowed.
3. Prefilling SHALL replace any text in the input, SHALL NOT submit the question, and SHALL keep working for repeated clicks on different tables.
4. WHEN there is no Ask panel (no queryable table), THE button SHALL NOT be shown.
5. THE prefill request SHALL be applied exactly once. After it is applied, THE owner SHALL drop the request (`onPrefillHandled`), "Reset lab" SHALL clear any pending request, and a remount of the Ask panel SHALL NOT apply an old request again. A new click SHALL always apply, even for the same table.

### Requirement 5: Reset lab race

**User Story:** As a user, I want loading to wait until a reset has finished, so that new tables are never given suffixed names or broken.

#### Acceptance Criteria

1. WHILE "Reset lab" is running, THE LoadControls SHALL be disabled: the drop zone and its browse button, every demo button, and "Apply recipe". The Reset lab button itself SHALL also be disabled.
2. WHILE a reset runs, THE application SHALL show the text "Resetting the lab..." in a polite live region. WHEN the reset finishes (success or failure), THE controls SHALL be enabled again and the message SHALL be removed.
3. THE load handlers (files, demo, recipe) SHALL ignore a request that arrives while the ResetLock is busy, so a keyboard or scripted trigger cannot bypass the disabled buttons.
4. A second reset request while one runs SHALL be ignored (coalesced).
5. A reset that throws SHALL still release the lock.
6. After a reset, loading a demo again SHALL produce unsuffixed table names (`monsters`, `experiments`).

### Requirement 6: Playwright slow mode

**User Story:** As a presenter, I want to watch the browser test at a human speed.

#### Acceptance Criteria

1. THE `playwright.config.ts` SHALL read the `E2E_SLOWMO` environment variable (milliseconds). WHEN it is a positive integer, THE browser launch SHALL use it as `slowMo`. OTHERWISE the default SHALL stay fast (no slow motion).
2. `E2E_SLOWMO=600 npm run test:e2e -- --headed` SHALL run the same spec at that speed.
3. THE e2e spec SHALL include one follow-up question after the starter chip. IF the AI proxy is not available in the test environment (the panel shows that AI is off), THE step SHALL be skipped without failing.
   - **Coverage:** the skip branch is exercised by `e2e/demo.spec.ts` on every run (the Vite dev server serves no `/api/sql`, so the panel always shows that AI is off).
   - **Waived:** the AI-on branch (typing the follow-up and expecting a result or an error alert). Reason: it needs a live `/api/sql` proxy with a real LLM key, Upstash and spend, which the automated run deliberately does not have, and a test must never call a real provider. It is covered by manual test step 3 in `NOTES.md` and by the unit tests of the thread request (`ask-controller.thread.test.ts`, `sql-proxy.thread.test.ts`).
4. THE e2e spec SHALL keep passing with the reset race fixed (it no longer needs to wait for the previews to disappear, but MAY still do so).

### Requirement 7: Privacy, limits, and non-interference

**User Story:** As a user, I want the same privacy and limits as before.

#### Acceptance Criteria

1. THE only data leaving the browser SHALL be what Feature 3 sends (column names, types, and a few short samples) plus the Thread (question text, SQL text, column names, row counts). No result row or value SHALL ever be sent.
2. THE SQL validator, the fetch cap, the proxy limits, the shared `cap:<day>` key, and the fail-closed behavior SHALL be unchanged. Changes to `api/` SHALL be limited to what this feature needs. `npm run check:api` SHALL pass.
3. THE feature SHALL add no runtime dependency.
4. WITH `VITE_AI_ENABLED` off, or the AI switch Off, the app SHALL make no network attempt for Ask (with or without a Thread) and SHALL keep working with starter chips.
   - **Coverage:** `src/core/chat/ask-controller.thread.test.ts` ("returns ai-unavailable with AI off and sends nothing": the build flag off, a Thread passed, no provider call) and `src/core/ai-off.duckdb.test.ts` ("free-form Ask shows the unavailable outcome and never calls fetch": the switch Off, with and without a Thread, a spied `fetch` never called, and called again once the switch is On as the positive control).
5. THE existing stitching, cleaning, recipe, Autopsy, and MCP behavior SHALL be unchanged.
6. THE "What leaves the browser?" disclosure SHALL list the follow-up Thread as its own line, built from `ASK_THREAD_MAX_TURNS` so the text cannot drift from the code: "Follow-up questions: your previous questions (at most 3 turns), the SQL that answered them, and the result column names and row counts." It SHALL keep stating that rows and result values are never sent.
   - **Coverage:** `src/core/ai-off.duckdb.test.ts` ("the disclosure states the real limits" checks the turn limit and the never-sent sentence) and `src/components/AiToggle.smoke.test.tsx` (every line of `describeEgress()` is rendered).

### Requirement 8: Correctness properties for property-based tests

**User Story:** As a developer, I want the safety properties checked by property-based tests.

#### Acceptance Criteria

1. **Property 1 (thread bounds and privacy)**: FOR ANY sequence of turns, THE derived Thread SHALL contain at most `ASK_THREAD_MAX_TURNS` turns, SHALL keep the most recent ones, and SHALL NOT contain any result row or cell value.
2. **Property 2 (payload cap)**: FOR ANY question, schema within its own cap, and Thread, THE request after budgeting SHALL serialize to at most the PayloadCap, and SHALL keep the newest ThreadTurns that fit.
3. **Property 3 (chart determinism)**: FOR ANY result shape, THE chart choice function SHALL give an identical result across repeated calls and independent of column set iteration order, and SHALL return a line only for temporal plus numeric and a bar only for text plus numeric.
4. **Property 4 (reset lock)**: FOR ANY interleaving of lock reads while a reset is running, THE LoadControls enabled state SHALL be false while the lock is busy, and true after it releases, including after a failure.
5. **Property 5 (proxy thread validation)**: FOR ANY malformed thread (unknown keys, too many turns, overlong or non-string fields), THE SqlProxy SHALL return `400 bad_request` and SHALL NOT call the LLM or touch the counters.
6. EACH property test SHALL reference its design property by tag in its header comment (**Feature: frankendata-smarter-ask, Property {n}: {title}**).
