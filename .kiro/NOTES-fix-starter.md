# Fix: starter chips that intermittently failed

Branch `fix-starter`, cut from `main`. Not merged.

**Report:** on the live site (AI on), after Load business demo, Autopsy, Fix all, stitch and Save recipe, the starter chip "What is the invoiced revenue by region in stitch_1_result?" showed "The lab could not answer that question." once, and worked on a retry.

## What I found

**1. The premise was not right: chips never went through the AI.** A chip click calls `controller.runSql(chip.sql, chip.question, chip.chart)` (`AskTheLabPanel.runChip`). `runSql` validates the chip's own rule-built SQL, wraps it with the fetch cap and runs it in DuckDB. It never touches the provider, and typed questions are the only path to `ask()` and the AI. So requirement 1 was already true, and the AI's varying SQL, timeouts and repair failures could not have caused a chip failure. I added tests that pin it (below) instead of changing the behavior.

**2. I could not reproduce the failure.** Against the real app in Chromium I ran the full flow (Load business demo, Autopsy, Fix all, Review, Approve all, Confirm, Apply, Save recipe) and clicked the stitched-result chip the moment it appeared:

| Condition | Result |
| --- | --- |
| AI off, normal speed, every one of the 23 visible chips, 3 runs | all answered |
| AI on in the build (`VITE_AI_ENABLED=true`), CPU slowed 1x, 6x, 6x and 10x | all answered |
| the new e2e test, 3 repeats | all answered |

The reproduction harness was temporary and is removed. That means I do not have a proven root cause for the one live failure, and I will not claim one.

**3. What the code does allow.** A chip fails with that message in exactly two ways: the validator rejects its SQL, or DuckDB throws. Reading the path end to end, these are the windows where a correct chip could fail once and then work:

- **The allowlist and the chips were updated at different moments.** The Ask panel refreshes its table list in an async effect after every stitch. It wrote the validator's allowlist (a module variable) inside that async block, and set the chips in React state, which renders later. For a short window the chips on screen and the allowlist could come from different refreshes.
- **A swallowed discovery error dropped the stitched tables.** `discoverStitchTables` caught any failure of its `information_schema` query and returned `[]`. One transient failure therefore produced a table list with no `stitch_*` tables, which silently removed them from the allowlist and the chips.
- **A single DuckDB error had no second chance.** The queries around a stitch (previews, probes for the chips, the Autopsy, Save recipe) share one connection. A one-off error in a chip's own query ended the chip.

These are real weaknesses and each one produces "fails once, works on retry", but I could not make any of them fire here, so treat them as likely contributors, not as a confirmed cause.

## What I changed

| Change | Where |
| --- | --- |
| A chip retries **once** (75 ms later, re-reading the allowlist) before it reports a failure, and then says "That starter question could not run just now, try it again." instead of the typed-question wording. No AI, no network. | `ask-controller.ts` `runSql` |
| The allowlist and the AI schema sources are now written from the same React state the chips render from, in a layout effect. | `App.tsx` (`AskPanelRegion`) |
| The Ask panel's refresh uses strict discovery: the `information_schema` query is tried twice, and if it still fails the refresh is abandoned and the previous, consistent list is kept (before: the stitched tables were dropped). The MCP tools keep the old non-strict behavior. | `queryable-tables.ts` |
| A diagnostics hook reports the failure **category** only (`rejected:<reason>`, `execution`, `timeout`, `provider-error`, `schema`) and the path (`chip`, `ask`, `repair`). Never SQL, names, values or the question. The app logs it with `console.debug` in development only. The next live failure in a dev build will say which kind it was. | `ask-controller.ts` `onDiagnostic`, `App.tsx` |
| Typed questions that fail now say why: read-only rule ("The lab only runs read-only queries on your loaded tables..."), a table that is not loaded, a query that failed even after the repair, a provider timeout ("The lab took too long to answer, try again."), or another provider failure. 429 and 503 still show "AI unavailable". | `ask-controller.ts` |
| `INTEGER` and `UINTEGER` columns were classified as text (the check was `endsWith("INT")`, and `INTEGER` does not end in `INT`). That affected which starter chips a table got and the column types the AI is told about, so a model could be told an integer column was text. | `queryable-tables.ts` `duckDbTypeToColumnType` |

Not changed: the validator. See the next section.

## The AI path: do valid model shapes pass the validator?

I ran about 55 SQL shapes a model plausibly writes for this question (and close cousins) through `validateSql` with the stitched tables allowed. They all pass, including quoted and unquoted identifiers, `ORDER BY` an alias, positional `GROUP BY`/`ORDER BY`, `ROUND`, `CAST`, `TRY_CAST`, `::` casts, `COALESCE`, `ILIKE`, `FILTER`, `CASE`, CTEs, subqueries, window functions, `date_trunc`, `strftime`, `EXTRACT`, joins, `UNION ALL`, `USING SAMPLE`, trailing semicolons, comments, `main.`-qualified names, and strings containing `;` or SQL words. **I found no false rejection, so I changed nothing in the validator.**

Rejected on purpose, and still rejected: an unquoted `copy` alias (a forbidden keyword as a whole word; a quoted alias like `"export"` is accepted), `memory.main.table` (only `main.` is allowed), `information_schema`, `SUMMARIZE`, tables that are not loaded, `DROP`/`COPY`/`ATTACH`/`PRAGMA`/`INSERT`, a second statement, `read_csv` in any position (also split by a comment or after a subquery), a NUL byte and a string path in a table position.

These are now a permanent test, `sql-validator.model-shapes.test.ts` (45 accepted shapes, 17 refused), next to the existing bypass and property tests, which all still pass.

How the AI path can still fail for a typed question, for what it is worth: a proxy or provider timeout (the client aborts after the request timeout), a 5xx from the provider, or SQL that is valid but wrong for the data (a bad column or cast), which gets one repair. Those now have their own messages, and in development the category is logged.

## Tests added

- `ask-controller.starter.test.ts`: a chip never calls the provider with AI on (working or failing); every business chip passes the validator for the tables it was made from; one transient DuckDB error and one stale-allowlist read are recovered by the retry; two failures give the chip message after exactly two runs; each typed-question failure maps to its message; the messages carry no SQL, table, value or dash; diagnostics contain only a category (checked with a secret table name, an SSN-like value and the question text); a throwing hook never changes an answer.
- `queryable-tables.test.ts`: discovery tries twice, strict mode throws, and INTEGER, UINTEGER and the other whole-number types are numbers.
- `sql-validator.model-shapes.test.ts`, described above.
- `AskTheLabPanel.thread.smoke.test.tsx`: with AI on, a chip calls `runSql` and not `ask`, and a typed follow-up carries the starter's question, SQL and result shape (names and counts, no row values) in its thread, exactly as before.
- e2e at 1600px, after Load, Autopsy, Fix all, stitch and Save recipe: the first starter (the one that failed live) answers and "I feel... whole." fires right after it, once; then **every** visible starter chip, including the ones behind "Show more", returns an answer with no error; the whole moment does not repeat.

## Gate

Run with `CI=true` and `VITE_AI_ENABLED` unset: lint (exit 0), `npm test` (204 files, 1417 tests), build, `check:api`, `mcp:build`, `npm run test:e2e` (25 tests) all pass. README counts updated.

## Still open

- If it happens again, open the browser console in a development build: the `[ask] could not answer:` line names the path and the category. In the production build the hook is off by design (nothing is logged).
- The live site is a production build; the repro here used the dev server with a throttled CPU. If it fails there but not here, the category will say whether it is a rejection or a DuckDB error.
