# Security hardening: run notes

Branch `security-hardening`, cut from `main` (0acc332). Four commits, not merged.

| Commit | Subject |
| --- | --- |
| A | validator: close FROM-list and comment-split bypasses |
| B | privacy: redact repair errors |
| C | api: harden proxies |
| D | specs: smarter-ask review fixes |

Method: every finding got a failing test first. For commit A the new tests were run
against the unfixed validator (`git show HEAD:src/core/chat/sql-validator.ts` copied to a
temporary file) and the result is recorded below. "Reproduced" means the unfixed code
accepted the input (or, for the false-rejection finding, rejected valid SQL). Nothing was
executed against a network.

## Commit A: validator

### Findings

| # | Finding (audit severity) | Reproduced? | Fixed | Covering tests |
| --- | --- | --- | --- | --- |
| A1 | FROM-list walk stopped after a subquery (High) | Yes. `SELECT * FROM (SELECT 1) q, secret_table` was accepted. In the MCP tool it reached DuckDB and failed with `query-failed` instead of `sql-rejected`. | Yes | `sql-validator.test.ts` "bypass: FROM-list walk must check every reference"; `mcp/src/tools.test.ts` "rejects FROM-list, comment-split, quoted-function and NUL bypasses"; property test below |
| A2 | Same, after an alias with a column list (`AS m(a)`) (High) | Yes, accepted | Yes | same |
| A3 | Same, after `TABLESAMPLE 10%` and `TABLESAMPLE bernoulli(10 PERCENT)` (High) | Yes, accepted | Yes | same |
| A4 | Comment-split function name (`read_/**/csv(...)`) after a subquery (High) | Yes, accepted. Also the old `stripForOutput` glued tokens: `SELECT 1/**/AS a` came out as `1AS a`. | Yes: a comment becomes one space, and the validator tokenizes the stripped text it returns | "bypass: blocked functions in any form"; "validates the same text it returns"; property tests |
| A5 | Quoted function names (`"read_csv"(...)`, `"READ_CSV"(...)`) (High) | Partly. Directly in `FROM` they were already rejected (as `unknown-table`). After a subquery or after `TABLESAMPLE` they were accepted. | Yes: quoted and unquoted, any case, any qualifier | same |
| A6 | Parenthesized table positions unchecked: `FROM (secret CROSS JOIN monsters)`, `FROM (range(5))`, `FROM (SUMMARIZE secret_table)` (Medium) | Yes, all accepted | Yes | "rejects a parenthesized join...", "rejects a table function inside parentheses" |
| A7 | Blocklist not exhaustive (Medium) | Only reachable through A1 to A5. `query`, `query_table`, `sniff_csv`, `parquet_file_metadata`, `glob`, `generate_series` after a subquery or in any generated position were accepted. DuckDB 1.4.3 has `query()` and `query_table()` (checked in the node bundle). | Yes: any call in a table position is rejected unless allow-listed (the allowlist is empty), plus a pattern blocklist everywhere | "bypass: blocked functions in any form"; `sql-validator.tables.property.test.ts` |
| A8 | NUL byte not rejected (Low) | Yes, accepted in all six positions tried | Yes: new reason `invalid-character` | "bypass: NUL bytes" |
| A9 | `FROM` inside `EXTRACT`, `SUBSTRING`, `TRIM`, `IS [NOT] DISTINCT FROM` treated as a table position (Low) | Yes, valid queries were rejected (`unknown-table`, or `table-function` when the argument was a call) | Yes, and only after every bypass test failed closed | "FROM inside functions is not a table position"; MCP "accepts EXTRACT, SUBSTRING, TRIM and IS DISTINCT FROM" |
| A10 | Tokenizer and output stripper disagreed on dollar quotes (Low) | Not reproduced as an exploit. The structural cause (two scanners) is gone: one scanner, and the stripped text is re-scanned and must match token for token. | Yes | "validates the same text it returns" |

### New findings from probing DuckDB 1.4.3 while fixing (not in the audit)

| # | Finding | Reproduced? | Fixed | Covering tests |
| --- | --- | --- | --- | --- |
| A11 | **E-strings.** DuckDB reads `E'\''` as one string (backslash escapes the quote). The old scanner ended the string at the `\`, so text after it was treated as a literal and hidden: `SELECT E'\'' ; DROP TABLE monsters; SELECT E'x'` was accepted. The fetch-cap wrapper would have broken it at execution, but the validator invariant was wrong. | Yes, accepted by the old validator | Yes: `E'...'` is scanned with backslash escapes | "lexing parity with DuckDB" (first two tests) |
| A12 | **A comma list after a join condition** was never checked: `FROM monsters m JOIN experiments e ON m.id = e.id, secret_table`. Same class as A1. | Yes, accepted | Yes: the walk parses joins, `ON` and `USING` | "rejects a join condition followed by a hidden comma-list table" |
| A13 | **Line comments end at `\r` in DuckDB**, the old scanner only at `\n`. | Yes (token list differed) | Yes | "ends a line comment at a carriage return" |
| A14 | **Block comments nest in DuckDB**, the old scanner did not. | Yes (a marker survived) | Yes | "nests block comments like DuckDB does" |
| A15 | **CTE alias scope.** The old code treated an alias as visible everywhere. A name defined inside a subquery or later in the same `WITH` could hide a real table. | Not exploitable in the old code (it only read leading aliases), but the new walk would have been if aliases were global. Pinned so it stays correct. | Yes: an alias is visible only in later CTEs and the main body | "scopes CTE aliases" |
| A16 | Statement starters in parentheses (`PIVOT`, `SUMMARIZE`, `DESCRIBE`, `SHOW`, `TABLE`, `EXPLAIN`) name a table without a `FROM`. | Yes (`FROM (SUMMARIZE ...)` accepted) | Yes: rejected | "rejects statement-starting words in parentheses" |

Observed but left as is: vertical tab (`\v`) is whitespace to the validator and an error to
DuckDB, and U+00A0 is whitespace to DuckDB and punctuation to the validator. Both fail safe
(an error, or an extra punctuation token that fails closed in a table position).

### What changed

- `src/core/chat/sql-validator.ts` rewritten around one scanner, a re-scan equality check, a
  blocked-function check on every call, and a structural FROM walker (`analyzeTables`) that
  handles comma lists, joins with `ON`/`USING`, parenthesized joins, subqueries, CTE scope,
  aliases with column lists, `TABLESAMPLE`, and the function-style `FROM`. Anything it
  cannot parse is rejected (`unparseable`). Public API (`validateSql`, `tokenize`) is
  unchanged; two reasons were added (`invalid-character`, `unparseable`).
- Property test `src/core/chat/sql-validator.tables.property.test.ts` (tag "Feature:
  frankendata-security-hardening, Property 1"): a bad table or blocked function at any
  position, depth, join shape and with comments between tokens is rejected; the same shapes
  with allow-listed entries are accepted (control).
- The existing `sql-validator.forbidden` and `sql-validator.limit` property tests and every
  golden test pass unchanged.
- This change touches `src/core` while the MCP conventions say MCP work must not change core
  behavior. It is a security fix to the shared validator, which the MCP `query` tool uses by
  design, so the MCP tool picks it up with no MCP code change.

### Defense in depth: `enable_external_access = false` plus `lock_configuration`

Checked on DuckDB 1.4.3 (node-blocking bundle), with a temporary probe that was deleted:

| Step | Result |
| --- | --- |
| `read_csv` on a local file before the lock | works |
| `COPY ... TO` a file before the lock | works |
| `SET enable_external_access = false` | OK |
| `read_csv` local file and `https://` URL after | fail |
| `INSERT`, `CREATE TABLE`, `CREATE TABLE AS`, `DROP`, `SELECT`, `information_schema` after | work |
| `COPY ... TO` after (real path or virtual name) | fails |
| `SET enable_external_access = true` after | fails (cannot be re-enabled) |
| `SET lock_configuration = true`, then `SET threads = 1` | the second fails; DML and DDL still work |

So the setting cannot be applied "after intake" and then lifted for export: it is one way and
database wide, not per connection. It does not need to be: intake parses in JavaScript and
writes with `INSERT ... VALUES`, and nothing in production uses `COPY` or a file function.
The only user is `exportFileBytes` (`COPY ... TO`), which no production code calls; the
Recipes tests have their own harness that does not go through the lock.

Applied: `src/db/duckdb-lockdown.ts` (`lockDownConnection`, fail closed), called right after
connect in the browser bundle (`src/db/duckdb-service.ts`) and in the MCP server
(`mcp/src/node-duckdb.ts`). Tests: `src/db/duckdb-lockdown.test.ts` (order, fail closed),
`mcp/src/lockdown.test.ts` (real DuckDB: local read and write fail, setting cannot be
re-enabled, intake-style SQL works). The browser bundle cannot run under jsdom; the Playwright
spec (`npm run test:e2e`, a real Chromium with the real worker) loads data, stitches, asks
and runs Autopsy with the lock on and passes, which is the check that intake still works there.

Consequence to know: if a future feature wants Parquet export through `COPY ... TO` in the
browser, it cannot run on this instance. It would need its own approach (for example writing
the file in JavaScript) or a deliberate, reviewed change to `lockDownConnection`.

### Gate after commit A

`npm test` (167 files, 1059 tests), `npm run build`, `npm run check:api`, `npm run mcp:build`,
`npm run test:e2e` (5 passed). `npm run lint`: warnings only (the existing
`set-state-in-effect` ones).

Not verified: that DuckDB-WASM in a browser can fetch `https://` URLs through `read_csv`. The
audit said it can; nothing here ran it, and with the lock on it is moot.

## Commit B: privacy, repair errors

| # | Finding | Reproduced? | Fixed | Covering tests |
| --- | --- | --- | --- | --- |
| B1 | The repair request sent the raw DuckDB error, which quotes cell values (Medium). `Could not convert string 'TOP-SECRET-9931' to INT32` went to `/api/sql` verbatim. | Yes. `ask-controller.repair.test.ts` failed with the raw value in `provider.calls[1].repair.error`. | Yes: `redactDuckDbError` keeps the first line (error type and message), turns every quoted span into `'<value>'`, masks bare numbers, caps at 300 characters. | `redact-error.test.ts` (conversion error with a quoted value, escaped quotes, a value containing a quote, `can't`, unterminated quote, number masking, cap); `redact-error.property.test.ts` (no leak, cap, idempotent); `ask-controller.repair.test.ts` |
| B2 | Server did not cap `repair.error`, `repair.previousSql`, `tableName` or column names (Low). | Yes. Over-limit values returned 200. | Yes: 300, 4000, 128, 128 characters, `400 bad_request` before any counter or LLM call. | `sql-proxy.repair.test.ts` (at the limit accepted, one over rejected, no Redis or LLM call) |
| B3 | "What leaves the browser?" did not mention the error message. | Yes. | Yes: the line "If a query fails, the error message with values removed." was added to `describeEgress()`, which feeds the popover. | `egress-description.test.ts`; the existing `AiToggle.smoke.test.tsx` and `ai-off.duckdb.test.ts` still pass |

Decisions to know about:

- Double-quoted spans are redacted too, as asked, so a `Referenced column "foo" not found` error becomes `Referenced column '<value>' not found`. The model still gets the failed SQL and the error type, but loses the column name from the message. That is the price of the rule.
- Beyond the request: bare numbers in the error become `<number>`, because an out-of-range cast prints its value without quotes (`Type INT64 with value 3000000000 can't be cast`). Type names such as `INT32` are untouched.
- A quote only opens a value when it is not glued to a word, and only closes it when it is not followed by a word character. That keeps `can't` as text and redacts `'O'Brien'` whole. A value that contains a quote followed by a space can still end early. Nothing in a regex can fully fix that; the first-line cut and the 300-character cap limit what could leak.
- The client truncates `previousSql` to 4000 characters before sending, and the schema builder now leaves out any table or column whose name is longer than 128 characters (`schema-builder.names.test.ts`). Without that, one very long CSV header would make the proxy refuse every Ask request. Those columns are invisible to the model.
- No change to status codes, error codes, the shared `cap:<day>` key or the `rlsql:` prefix.

Gate after commit B: `npm test` (173 files, 1082 tests), `npm run build`, `npm run check:api`, `npm run mcp:build`, `npm run test:e2e` (5 passed).

## Commit C: proxies

| # | Finding | Reproduced? | Fixed | Covering tests |
| --- | --- | --- | --- | --- |
| C1 | A non-numeric Redis counter reply compared as "not over the limit" and failed OPEN (Low). | Yes. NaN, Infinity, `"5"`, `"abc"`, null, undefined, 0, -3, 1.5 and an object were each served a 200 and reached the LLM, for both the per-client and the daily counter, in both proxies. | Yes: `requireCount` (positive safe integer) inside the counter `try`, so any other value is `503 unavailable` with no LLM call. | `ai-proxy.hardening.test.ts`, `sql-proxy.hardening.test.ts` (20 cases each) |
| C2 | No timeout on the Upstash and LLM `fetch` calls (Low). | Yes. With a stubbed `fetch` that only answers on abort, both handlers never finished; the test loop ended with no response. | Yes: 10 seconds (`UPSTREAM_TIMEOUT_MS`) covering the request AND the body read, via an `AbortController`. A timeout rejects, which the core turns into `503 unavailable`. When Upstash hangs the LLM is never called. | `api/upstream.timeout.test.ts` (both handlers, both upstreams, body-read timeout, normal reply still works) |
| C3 | `parseLlmResponse` and `parseSqlLlmResponse` returned the whole model object, so unknown fields reached the browser (Low). | Yes. `apiKey`, `debug`, nested objects and extra chart keys were passed through. | Yes: only `id`/`confidence`/`reason` per refinement (wrong-typed entries dropped, at most 30) and only `sql`/`explanation`/`chart{type,x,y}` (chart dropped unless well formed and `bar|line|pie`). | the "returns only the known fields" blocks in both hardening test files |

Not changed on purpose: status codes, error codes, `rl:`/`rlsql:` prefixes, the shared `cap:<day>` key, the check order, `api/ai.test.ts`, `api/sql.test.ts` and the existing proxy tests (all pass unchanged). `makeUpstashRedis` and `makeLlmClient` gained an optional third argument used only by tests.

### Is `ALLOWED_ORIGINS` required? No. Should you set it? Yes, for production.

- The proxies work without it. When it is unset or empty the origin check is skipped (`originAllowed` returns true when the allow-list is empty), which is also what `DEPLOY.md` and `.env.example` document. Nothing breaks and nothing fails closed because of it.
- It is a courtesy check, not authentication. `curl` or a script can send any `Origin` header, so it does not stop a determined caller. What actually protects you is the per-client hourly limit (20), the shared daily cap (500) and a provider-side monthly budget.
- Why set it anyway: it makes the proxies refuse requests that declare a foreign `Origin`, which cuts casual abuse and noise. Browsers already block cross-site `fetch` calls to these routes (no CORS headers are sent and a JSON `Content-Type` forces a preflight), so this adds little against browsers.
- If you set it: use your deployed origin, with scheme and no trailing slash (`https://your-app.vercel.app`), comma separated for several (production domain, custom domain). Once it is set, a request with no `Origin` header or any other origin gets `403 forbidden_origin`. Vercel preview deployments have their own origins and will be refused unless you list them. Same-origin `POST` requests from the app do carry an `Origin` header.
- I did not change any Vercel setting or `.env.example`.

The two real exposures the audit found are unchanged by this and need your decision: there is no authentication (so anyone can spend the shared daily cap of 500), and the client IP is read from `x-forwarded-for`, which is only trustworthy behind Vercel.

Gate after commit C: `npm test` (176 files, 1142 tests), `npm run build`, `npm run check:api`, `npm run mcp:build`, `npm run test:e2e` (5 passed).
