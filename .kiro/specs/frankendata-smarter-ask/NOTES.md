# Smarter Ask: run notes

## Summary

- **Follow-ups:** Ask the Lab keeps the last 3 successful turns in the browser (`AskStore.turns`). A free-form question sends a `thread` of those turns reduced to question text, SQL text, result column names and a row count. No result row or value is ever sent. The request is trimmed to the shared 20 KiB payload cap by dropping the oldest turns first. "New topic" clears the turns and announces it.
- **Thread view:** earlier turns appear as compact cards above the current answer (question, collapsed SQL, row count, chart). Nothing scrolls. The newest answer takes focus (`preventScroll`) only when the user submitted the Ask form, not for chips or history buttons.
- **Line charts:** a pure `chooseChart` picks a line for exactly one date or timestamp column plus one numeric column (at least 2 rows), and a bar for one text plus one numeric column. A hand-built SVG `LineChart` renders it with a visually hidden data table.
- **Ask about this:** a small button on each table card (original tables and the stitched result) prefills the Ask input with `In <table>: `, focuses it, and scrolls the panel into view (instant under reduced motion).
- **Reset race:** a `ResetLock` disables the drop zone, all three demo buttons, "Apply recipe" and the Reset button while a reset runs, shows "Resetting the lab...", and makes the load handlers ignore requests.
- **Playwright:** `E2E_SLOWMO` sets `slowMo`; the spec gained an "Ask about this" check and a follow-up step that is skipped when AI is off.

## Decisions made without asking

- The thread is derived from `AskStore.turns` (which keep full outcomes for the cards) by `toThread`, so what leaves the browser is a separate, privacy-reduced shape.
- Turns are added for every successful result, including starter chips, so "sort that by count" works after a chip. A chip answer never sends a thread itself (chips run without AI).
- With no thread, the call to `controller.ask` and the request body are identical to before (`ask(question)`, no `thread` key). This keeps existing tests and the wire format unchanged for first questions.
- Chart choice: only the line choice is automatic. Bar charts still need a valid model or chip bar spec, exactly as before, so no existing result gains or loses a bar chart. `chooseChart` can return a bar (and is tested for it) but the controller uses it only for the line case.
- SQL in a thread is cut at 1000 characters. A cut SQL is plain context text for the model; it is never executed.
- The proxy validates `thread` before the origin check, the counters and the LLM, so a malformed thread never touches Redis or the model. Status codes, error codes, `rlsql:` prefix, shared `cap:<day>` key and the output token cap are unchanged. `api/sql.ts` needed no change (it delegates to the core handler).
- The proxy prompt now also mentions line charts (one date or timestamp column plus one numeric column).
- "Ask about this" uses a React context so the button appears on both the table list and the stitched result card without threading props through `StitchStage`.
- `DropZone`, `DemoDataControl` and `ApplyRecipe` got an optional `disabled` prop (default false). Nothing else about them changed.

## Deviations

- Requirement 3.7 says a model `line` spec that does not match the rule is dropped. That already happens because `validateChartSpec` treats line as not renderable; no code change was needed.
- The e2e slow-mode and the follow-up step run in this environment only up to the AI-off skip, because the Vite dev server does not provide `/api/sql`. The follow-up branch for AI on is not exercised.
- The reset race has no browser-level test: the unit tests cover the lock, the disabled props, and a property test covers the lock state machine. The App wiring itself (handlers ignoring requests while busy) is not rendered under jsdom.

## Known issues

- Follow-up quality depends on the model. A follow-up the model cannot resolve returns a normal query or the friendly error.
- A thread card shows the chart at full size, so a card with a chart is tall.
- The "New topic" note is cleared when the next turn is added; it is announced once per click only if the text changed.
- Lint reports warnings only (existing `set-state-in-effect` pattern, plus the new effect in `AskTheLabPanel` which has an eslint-disable comment for its dependency list).

## Exact manual test steps

1. `npm run dev`. Click "Load demo data" (three files). Note that `monsters` has `captured_on` (a date) and `containment_cost` (a number).
2. Click the starter question "How many rows per ... in monsters?" Expect a table and, because the chip has a bar spec, the usual bar chart. Click "Ask about this" on the monsters card: the Ask input shows `In monsters: ` and has focus.
3. With AI on (live site or a local `.env` with the proxy variables): ask "In monsters: containment cost over time by captured date". Expect SQL selecting `captured_on` and a number, a line chart and a screen-reader data table. Then ask "now only the ones above 1000". Expect the previous question as a card above, and a new answer; the new answer has focus and the page does not scroll.
4. Click "New topic". Expect the cards to disappear, the answer to stay, and "Started a new topic" announced. Ask a follow-up: it is treated as a fresh question.
5. With AI off, ask any free-form question: the existing "AI is unavailable" message appears and no network call is made.
6. Load "Load mismatched demo", click "Reset lab" and immediately try the demo buttons, the drop zone and "Apply recipe": they are disabled and "Resetting the lab..." shows. After it finishes, loading "Load mismatched demo" gives `monsters` and `experiments` (no `_2`).
7. `npm run test:e2e`, and `E2E_SLOWMO=600 npm run test:e2e -- --headed` to watch it.

## Verification

- `npm test`: 154 files, 953 tests passing. `npm run build`, `npm run check:api`, `npm run mcp:build` pass. `npm run lint`: no errors. `npm run test:e2e` passes.
- Properties: thread bounds and privacy, payload cap with a thread, chart determinism, reset lock, proxy thread validation.

## Credits used

About 140 of the 300 budget (an estimate; I have no exact meter).
