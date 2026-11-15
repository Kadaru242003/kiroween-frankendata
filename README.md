# FrankenData

Stitch mismatched CSV and XLSX files into one living dataset, then ask it questions in plain English. Everything runs in your browser, with a small stitched-together creature, Little Frank, to keep you company.

**Live demo:** https://kiroween-frankendata.vercel.app

## Try it in 60 seconds

1. Click **Load business demo**. A CRM export (`crm_customers`, 22 rows) and a billing export (`billing_invoices`, 48 rows) that never agree appear on the slab, and Little Frank comes alive with a lightning strike.
2. Click **Stitch tables**.
3. Click **Approve all suggestions**.
4. Click **Confirm & stitch**, then **Apply & stitch**. The tables are joined on the email key (billing emails that differ in casing or spacing still match), giving 48 rows in `stitch_1_result`.
5. In **Ask the Lab**, ask "Which region has the most overdue invoices?" Free-form questions need AI on, as it is on the live site. With AI off, the starter questions still work, for example "What is the monthly revenue by region in crm_customers?" (a bar chart) or "What is the invoiced amount by month?" (a line chart).

Then click **Autopsy** on the `crm_customers` card to see its health score (79), the breakdown and the per-column findings. With AI on, the stitching screen can also surface "AI found this" for `client_name` and `Customer_Name`, a pair the rules scored too low (0.38) to show.

**AI: On / Off (fully local):** when the build has AI enabled, a switch in the header turns every AI request off for the session. The "What leaves the browser?" note lists exactly what is sent when it is on. When the build has AI disabled, the header says "Fully local".

## Try the recipe flow

1. Load the business demo and stitch it as above (48 rows).
2. In the **Recipes** panel under the stitched result, click **Save recipe**. A small JSON file downloads (names and types only, never row values).
3. Open **Load demo** in the toolbar and choose **Business: next month**. The same CRM (with 2 new customers and a few duplicate rows) and 24 April invoices (mixed `Paid` and `paid`, emails in other casings) replace the tables on the slab.
4. Click **Apply recipe** and choose the saved file. Every matched step and cleanup comes back pre-approved ("Recipe applied: N steps pre-approved, 0 not applied"). Nothing stitches on its own.
5. Click **Review in stitching table**, then **Confirm & stitch** and **Apply & stitch**. The result has 24 rows, one per April invoice, every invoice matched, and no fan-out warning.

## Try the monster demo

1. Click **Load mismatched demo**: two files about the same creatures with different headers.
2. Stitch as above (**Stitch tables**, **Approve all suggestions**, **Confirm & stitch**, **Apply & stitch**) for 12 rows in `stitch_1_result`.
3. Click the starter question "How many rows per Species in stitch_1_result?": Swamp Wraith has a count of 3. The Autopsy on `monsters` scores 81. **Load demo data** loads three more files, and **Lab: next month** brings new rows for a lab recipe.

## Try a follow-up question

With AI on (the live site, or a local `.env` with the proxy variables):

1. After stitching, ask "which species is most common?" in **Ask the Lab**.
2. Ask "now only the High threat ones". The previous question appears as a card, and the new answer keeps the grouping and ordering and adds the filter.
3. Click **New topic** to clear the thread and the input. Click **Ask about this** on any table card to start a question about that table.

With AI off, free-form questions show a message and the starter questions keep working.

## Features

- **Browser-only engine:** DuckDB-WASM runs entirely client-side, with no server round trip for your data.
- **Typed intake:** CSV (PapaParse) and XLSX (SheetJS 0.20.3 from the official release) are parsed and type-inferred through messy real-world values (currency, percents, mixed date formats, null tokens). Demo datasets are bundled.
- **AI stitching with a rules-first engine:** a deterministic rules engine proposes column matches and cleanups. The optional AI only nudges scores of candidates the rules already found, and can surface an **"AI found this"** discovery that the rules scored too low to show. Every proposal carries an engine badge.
- **Approval flow:** review each match and cleanup as a before and after diff, approve, reject or edit (re-pair a match, change a category's canonical value), approve in bulk, confirm, choose the anchor and join keys, apply, and undo. Originals are never changed; results are `stitch_<n>_*` tables. The default join key and anchor are chosen by how key-like the columns are, and the key you pick in the Join dropdown is the key the SQL uses.
- **Autopsy:** a data quality case file for any table or stitched result, with a transparent 0 to 100 health score, per-column findings, and **Fix it** buttons that add the matching cleanup to the approval flow. Export the report as Markdown or JSON.
- **Recipes and export:** save a stitch as a recipe and replay it on new files through a strict validator and mapper. Export any table as **CSV or Excel**, and export a readable **DuckDB SQL script** of the cleanups and join.
- **Ask the Lab:** plain-English questions become one read-only DuckDB query, checked by the SQL validator, with a table, the SQL, a CSV export, and **bar and line charts** (with a data table for screen readers). **Follow-up questions** use the last 3 turns as context (question text, SQL, column names and row counts only). **New topic** clears the thread, and **Ask about this** on a table card starts a question about that table.
- **Fully local switch:** an "AI: On / Off (fully local)" header switch (or a static "Fully local" label when the build has AI off), with a "What leaves the browser?" disclosure built from the same limits the payload builders use.
- **Starter questions that work with AI off:** deterministic example questions per table run with no LLM call at all.
- **Little Frank:** the lab's mascot, a patchwork creature stitched from mismatched parts, in the corner of the screen.
  - **The wake:** loading the first data brings a forked lightning bolt, a flash, a small page shake and sparks, then he jolts upright and says "It's alive!". The bolt is generated fresh for each strike.
  - **Reactions to every action:** he peers at proposals, nods, gives a thumbs up or shrugs at your decisions, sews when you confirm a stitch and wears bandages and a new seam once it is applied, grabs his head at a fan-out warning, puts on a stethoscope for an Autopsy (and faints at a low score), writes on and stamps a recipe scroll, bubbles a flask while a question is pending, smokes on an error, waves goodbye to an export, unplugs a cable when AI goes off, and flickers out on Reset lab. After a minute of quiet he falls asleep, and now and then he reads a tiny book or nibbles an acorn.
  - **Poking:** tap him (or press Enter or Space). He gets more annoyed with each poke, and ten in a row bring a harmless Halloween surprise. Before any data is loaded, or after Reset lab, he only mumbles "5 more minutes..." and stays asleep.
  - **Ask Little Frank:** the round **?** button by his head opens a speech bubble that answers questions about the lab from a local table of 21 topics, with suggested questions, a tip for your next step, and no network call at all. He is written after the creature in Mary Shelley's 1818 novel, not the film monster: gentle, eloquent and well read, he learned to read by watching a family through a chink in a cottage wall, and he lives on acorns and berries.
  - **Calm Frank and reduced motion:** a **Calm Frank** toggle (remembered in your browser) turns off his animations and keeps the poses and speech bubbles. `prefers-reduced-motion` does the same: no lightning, flash or shake, only still poses and fades.
- **Lab shelf:** on screens at least 1440px wide, a shelf in the empty right gutter works as page navigation. A Tesla coil crackles over one jar per section of the page (Intake, Stitching, Result, Recipes, Ask, Autopsy, Tables), shown only while that section exists. Each jar's liquid is empty, half or full as you complete the step. Click a jar to scroll to its section and move focus to its heading, and the jar for the section in view is highlighted. The coil arcs with Frank's wake and sparks when you confirm a stitch. It is static under Calm Frank or reduced motion, and not rendered below 1440px.
- **FrankenData MCP server:** the same engine as eight `frankendata_*` tools for AI agents such as Kiro, over stdio, with a path guard, no network and no AI (see below).
- **End-to-end tests:** 20 Playwright tests run the demos, Little Frank and the lab shelf in a real browser.

**By the numbers:** 8 specs, 10 steering docs, 9 hooks, 2 custom agents, 8 MCP tools in 1 MCP server of ours (the config also lists a disabled Playwright server), 202 test files with 1318 tests (74 of them property-test files), 20 Playwright end-to-end tests.

## Architecture

```
Browser (everything about your data stays here)
  Intake (CSV/XLSX parse, type inference)
      v
  DuckDB-WASM (in-memory SQL, external access locked)
      ^            ^
  Stitching engine (rules + optional AI)
      v
  Ask the Lab  ->  SQL validator (read-only, allow-listed tables)

Edge (serverless, no data stored)
  /api/ai   proxy  )  Upstash rate limit + shared daily cap -> LLM
  /api/sql  proxy  )

Only column names and a few sample values ever leave the browser.
```

## Safety by design

- **Your data stays in the browser.** Rows are never uploaded, and refreshing the page discards everything.
- **Minimal egress:** only column names, types, and a few short sample values per column leave the browser, and only when AI is enabled.
- **DuckDB is locked down.** Right after the instance opens, in the browser and in the MCP server, the app runs `SET enable_external_access = false` and then `SET lock_configuration = true`. SQL cannot read or write files or fetch URLs, and cannot switch that back on, even if a query got past the validator.
- **Read-only SQL validator:** every generated query must be a single SELECT or WITH over the loaded tables. Forbidden keywords, file and network functions, extra statements and any table not on the allow-list are rejected, however they are hidden (in a subquery, after an alias, split by a comment, quoted).
- **The validator checks the exact text that runs.** It strips comments itself, scans the stripped text again and requires the two scans to match token for token, and only that text (inside a row-cap wrapper) is executed, so what was checked is what DuckDB sees.
- **Redacted repair errors:** when the model is asked to fix a failing query, the DuckDB error is cut to its first line, quoted values become `'<value>'`, bare numbers are masked and the text is capped at 300 characters, so a cell value in an error message never leaves the browser. The server also caps the repair fields.
- **Fail-closed proxies:** missing config, an unreachable rate-limit store, a counter reply that is not a positive integer, or any upstream error returns "unavailable" and never calls the LLM.
- **10 second upstream timeouts:** the rate-limit store and the LLM are each called with a 10 second timeout that covers the request and reading the body. A hang becomes "unavailable" instead of a stuck request.
- **Origin allow-list:** set `ALLOWED_ORIGINS` and the proxies answer `403 forbidden_origin` to a request with a missing or unlisted `Origin`. It is a courtesy check, not authentication. The per-client hourly limit and the shared daily cap are what actually bound abuse.
- **Bounded AI influence:** the AI only re-scores candidates the rules engine already found. It can adjust a visible match by at most 0.2 either way, or lift a borderline candidate by at most 0.3 to surface an "AI found this" discovery. It cannot go below the 0.25 candidate floor, cannot override hard type gates, and discovered matches can never reach the 0.85 auto-approve threshold. The proxies pass on only the fields the app uses.
- **Case-insensitive join keys:** text join keys are compared after trimming, collapsing whitespace and lower-casing, so `Jane.Doe@Example.com ` still meets `jane.doe@example.com` instead of silently producing an unmatched row.
- **Row caps:** results are bounded so a huge query can never flood the browser, and the on-screen table is capped with a full-result CSV export.

## How we used Kiro

Built for the Kiroween 2026 hackathon (Frankenstein category) with Kiro. Everything below is checked into the repo.

**Specs** (`.kiro/specs/<name>/` with `requirements.md`, `design.md`, `tasks.md`, and `NOTES.md` where an autonomous run recorded decisions)

| Spec | What it covers |
| --- | --- |
| `frankendata-file-intake` | CSV/XLSX intake, type inference, DuckDB tables, demo data |
| `frankendata-ai-stitching` | rules engine, approval screen, apply and undo, optional `/api/ai` |
| `frankendata-chat-sql` | Ask the Lab, SQL validator, charts, `/api/sql` |
| `frankendata-autopsy` | data quality report, health score, Fix it |
| `frankendata-recipes` | export, save and apply recipes, SQL script, next-month demo |
| `frankendata-mcp` | local MCP server for agents |
| `frankendata-smarter-ask` | follow-up questions, thread view, line charts, Ask about this, reset lock |
| `frankendata-little-frank` | reactions, the lightning wake, the offline Ask Little Frank guide, Calm Frank, the personality and look |

The lab shelf, the join-key work, the security hardening and the other follow-ups were built from written briefs, and each recorded its decisions and verification in a `.kiro/NOTES-*.md` file.

**Steering** (`.kiro/steering/`)

| File | Inclusion |
| --- | --- |
| `product.md`, `tech.md`, `structure.md` | always (no front matter) |
| `security.md` | always |
| `api-conventions.md` | fileMatch `api/**` |
| `testing.md` | fileMatch `**/*.test.*` |
| `design-system.md` | fileMatch `src/components/**` |
| `data-engine.md` | fileMatch `src/core/**` |
| `mcp-conventions.md` | fileMatch `mcp/**` |
| `release-checklist.md` | manual (`#release-checklist`) |

**Hooks** (`.kiro/hooks/`)

| File | Trigger |
| --- | --- |
| `run-test-suite.json`, `check-api.json`, `pre-commit-quality-gate.json` | user triggered |
| `demo-smoke.json`, `readme-sync.json` | user triggered |
| `sql-validator-guard.json` | file edited: `src/core/chat/sql-validator.ts` |
| `spec-sync.json` | file edited: `src/core/**/*.ts` |
| `a11y-check.json` | file edited: `src/components/**/*.tsx` |
| `mcp-rebuild.json` | file edited: `mcp/src/**/*.ts` |

**MCP servers** (`.kiro/settings/mcp.json`)

- `frankendata`: our own server (`mcp/`), enabled, with eight tools. See the next section.
- `playwright`: `@playwright/mcp`, disabled by default, for agent-driven browser checks.

**Custom agents** (`.kiro/agents/`, Markdown with front matter)

- `spec-reviewer.md`: read-only review of a spec against the steering docs and the code.
- `security-auditor.md`: read-only audit of a change against `security.md`, the SQL validator and the MCP path guard.

**What the agents found**

- **`security-auditor`, on the proxies and the SQL validator.** It found a validator bypass: the check of the `FROM` list stopped after a subquery, an alias or `TABLESAMPLE`, and a blocked function split by a comment (`read_/**/csv(...)`) or written as a quoted name got through. Every finding got a failing test first. Against the old validator the new tests failed 36 times, 26 of them bypass and lexing cases (the other 10 were valid queries the old validator wrongly rejected and two property-test cases). The validator was rewritten around one scanner and a structural walk of every table position, and the DuckDB lockdown above was added as a second layer. It also found that a repair request sent the raw DuckDB error, which quotes cell values (`Could not convert string 'TOP-SECRET-9931' to INT32` reached the proxy verbatim), now redacted. Smaller findings (a non-numeric counter failing open, no upstream timeouts, unfiltered model fields) are fixed too. The audit trail is in `.kiro/NOTES-security-hardening.md`.
- **`spec-reviewer`, on `frankendata-smarter-ask`.** It found a requirement that contradicted the code: the spec said a text-plus-number result "SHALL" be a bar chart, but the controller only draws a bar when a supplied chart spec passes validation, and only the line chart is automatic. The requirement was rewritten, and the spec gained the missing criteria (New topic and Reset behavior, the one-shot prefill, the egress line for follow-ups) and coverage for the criteria that had none.
- **Found while testing: the Join key dropdown never changed the SQL.** A fixture test for the new default join key returned 8 rows instead of 5. The join planner picked the highest-confidence match between two tables and never read the key chosen in the dropdown. It now tries the chosen key first, the default is picked by key-likeness, and text keys compare case-insensitively (`.kiro/NOTES-join-key.md`).

**Tests:** Vitest unit, property (fast-check) and DuckDB golden tests under `npm test` (202 files, 1318 tests), plus 20 Playwright tests in `e2e/demo.spec.ts` under `npm run test:e2e`.

We drove each spec through spec-driven task execution with Kiro, ran the build, tests, lint and the serverless graph check at every checkpoint, and used focused prompts for follow-ups.

## Use FrankenData from Kiro (MCP)

The same engine that runs in the browser is also available to AI agents through a local MCP server. It runs on your machine over stdio, makes no network calls, calls no AI, and only reads files inside one allowed folder.

**Set up**

1. `npm install`
2. `npm run mcp:build` (bundles `mcp/dist/server.js`)
3. Open the repo in Kiro. The workspace config `.kiro/settings/mcp.json` registers a `frankendata` server. Check it in the MCP Server view and make sure it is enabled.
4. Optional: set `FRANKENDATA_MCP_ROOT` in that file to the folder that holds your data. The default is the workspace root. Exports go to `frankendata-output/` inside that folder and never overwrite without an explicit flag.

**Tools:** `frankendata_load_files`, `frankendata_autopsy`, `frankendata_propose_stitch`, `frankendata_apply_stitch`, `frankendata_apply_recipe`, `frankendata_query`, `frankendata_export`, `frankendata_reset`.

**Three prompts to try in Kiro chat** (the demo CSVs are in `mcp/fixtures`)

1. "Load mcp/fixtures/monsters.csv and mcp/fixtures/experiments.csv with FrankenData and run an autopsy on monsters. What is wrong with the data?"
2. "Propose a stitch for the two tables. Show me the matches and cleanups, then apply the ones with high confidence and tell me how many rows the result has."
3. "Which species is most common in the stitched result? Then export the stitched table to CSV."

### End-to-end browser tests

`npm run test:e2e` (add `E2E_SLOWMO=600` and `-- --headed` to watch it) runs 20 Playwright tests (`e2e/demo.spec.ts`) in a real browser against the Vite dev server. They are not part of `npm test`. First run `npx playwright install chromium`. They cover:

- **The demos end to end:** the mismatched demo (12 rows, Swamp Wraith 3, Autopsy 81), a saved recipe replayed on next month's files, the business demo (48 rows, revenue by region, Autopsy 79), and the business recipe on April's invoices (24 rows).
- **The toolbar and the page:** the Load demo menu order, the Apply recipe tooltip, the Autopsy scrolling into view, and the landing layout at 100% and 67% zoom.
- **Little Frank:** the lightning wake, tapping and keyboard pokes, the sleepy poke before any data, the **?** guide (the privacy answer, the answer above the chips, Esc to close), reduced motion with no bolt or running animation, and effects that never block a click.
- **The lab shelf:** at 1600px, the jars that appear as the lab progresses, their order, names and tooltips, navigation and focus, the highlighted section, filling jars and the short-window scale; and at 1280px, no shelf at all.

For agent-driven browser checks, the Playwright MCP server is registered in `.kiro/settings/mcp.json` but disabled by default. Enable it in the MCP Server view in Kiro, start `npm run dev`, then ask Kiro to open the app and click through the demo.

## Tech stack

- React 19 + Vite + TypeScript
- DuckDB-WASM (in-browser SQL)
- PapaParse (CSV), SheetJS (XLSX)
- Vitest + fast-check (property tests), Playwright (end to end), oxlint
- Vercel serverless functions for the optional `/api/ai` and `/api/sql` proxies
- Upstash Redis for proxy rate limiting and the shared daily cap

## Run locally

```
npm install
npm run dev        # start the Vite dev server
npm test           # run the test suite (vitest)
npm run build      # type-check and production build
npm run check:api  # verify the serverless function graph resolves
npm run test:e2e   # the Playwright tests (npx playwright install chromium first)
```

The app is fully functional with no configuration: with AI off it runs the offline rules engine and the no-AI starter questions. To enable the optional LLM features, set the variables from `.env.example` (names only shown here):

- `VITE_AI_ENABLED` (the only client-visible flag)
- `AI_PROVIDER`, `AI_MODEL`, the provider API key (`AI_API_KEY`, or the provider's own variable named in `.env.example`), optional `AI_BASE_URL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `IP_HASH_SALT`, optional `ALLOWED_ORIGINS`

## Deployment

See [DEPLOY.md](DEPLOY.md) for Vercel setup, the WASM size caveat, and the manual steps.

## License

MIT
