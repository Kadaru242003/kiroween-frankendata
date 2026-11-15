# FrankenData

Stitch mismatched CSV and XLSX files into one living dataset, then ask it questions in plain English. All in the browser.

Built for the Kiroween 2026 hackathon, Frankenstein category: a mad-scientist lab that bolts together React, DuckDB-WASM, PapaParse, SheetJS, and an optional LLM into one client-side creature.

**Live demo:** https://kiroween-frankendata.vercel.app/

## Try it in 60 seconds

1. Click **Reset lab** (if any tables are already loaded) to start clean.
2. Click **Load business demo**: a CRM export (`crm_customers`, 22 rows) and a billing export (`billing_invoices`, 48 rows) that never agree. They have duplicate customers, casing and whitespace variants, mixed date formats, currency strings and nulls.
3. Click **Stitch tables**, then **Approve all suggestions**, then **Confirm & stitch**, then **Apply & stitch**. The tables are joined on the email key (billing emails that differ in casing are cleaned first), giving 48 rows.
4. In **Ask the Lab**, click the starter question "What is the monthly revenue by region in crm_customers?" for a bar chart, or "What is the invoiced amount by month (from invoice_date)?" for a line chart. Starter questions run with no AI at all.
5. Click **Autopsy** on the `crm_customers` card to see its health score (79), the breakdown, and the per-column findings.

With AI on, the stitching screen can also surface "AI found this" for `client_name` and `Customer_Name`, a pair the rules scored too low (0.38) to show.

**AI: On / Off (fully local):** when the build has AI enabled, a switch in the header turns every AI request off for the session. The "What leaves the browser?" note lists exactly what is sent when it is on. When the build has AI disabled, the header says "Fully local".

## Try the monster demo

1. Click **Load mismatched demo**: two files about the same creatures with different headers.
2. Stitch as above (**Stitch tables**, **Approve all suggestions**, **Confirm & stitch**, **Apply & stitch**) for 12 rows in `stitch_1_result`.
3. Click the starter question "How many rows per Species in stitch_1_result?": Swamp Wraith has a count of 3. The Autopsy on `monsters` scores 81. **Load demo data** loads three more files.

## Try the recipe flow

1. Load the monster demo and stitch it (month one, steps 1 and 2 of the monster demo).
2. In the **Recipes** panel under the stitched result, click **Save recipe**. A small JSON file downloads (names and types only, never row values).
3. Click **Reset lab**, then **Load next month's files** (same headers, new rows, new duplicates and spellings).
4. Click **Apply recipe** and choose the saved file. The matches and cleanups come back pre-approved and anything that could not be mapped is listed as "not applied". Nothing stitches on its own.
5. Click **Review in stitching table**, then **Confirm & stitch** and **Apply & stitch**. Month two has the same 12 row shape.

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
- **Approval flow:** review each match and cleanup as a before and after diff, approve, reject or edit (re-pair a match, change a category's canonical value), approve in bulk, confirm, choose the anchor and join keys, apply, and undo. Originals are never changed; results are `stitch_<n>_*` tables.
- **Autopsy:** a data quality case file for any table or stitched result, with a transparent 0 to 100 health score, per-column findings, and **Fix it** buttons that add the matching cleanup to the approval flow. Export the report as Markdown or JSON.
- **Recipes and export:** save a stitch as a recipe and replay it on new files through a strict validator and mapper. Export any table as **CSV or Excel**, and export a readable **DuckDB SQL script** of the cleanups and join.
- **Ask the Lab:** plain-English questions become one read-only DuckDB query, checked by the SQL validator, with a table, the SQL, a CSV export, and **bar and line charts** (with a data table for screen readers). **Follow-up questions** use the last 3 turns as context (question text, SQL, column names and row counts only). **New topic** clears the thread, and **Ask about this** on a table card starts a question about that table.
- **Fully local switch:** an "AI: On / Off (fully local)" header switch (or a static "Fully local" label when the build has AI off), with a "What leaves the browser?" disclosure built from the same limits the payload builders use.
- **Starter questions that work with AI off:** deterministic example questions per table run with no LLM call at all.
- **Little Frank:** a mascot stitched together from spreadsheet cells who reacts to every step: asleep until you load data, goggles while you review, bandages when you stitch, a chart sign for answers, a magnifying glass for the Autopsy, a recipe scroll after a recipe.
- **FrankenData MCP server:** the same engine as eight `frankendata_*` tools for AI agents such as Kiro, over stdio, with a path guard, no network and no AI (see below).
- **End-to-end test:** a Playwright spec runs the whole demo in a real browser.

**By the numbers:** 7 specs, 10 steering docs, 9 hooks, 2 custom agents, 2 MCP servers (1 enabled), 159 test files with 975 tests (63 of them property-test files), 2 Playwright end-to-end tests.

## Architecture

```
Browser (everything about your data stays here)
  Intake (CSV/XLSX parse, type inference)
      v
  DuckDB-WASM (in-memory SQL)
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
- **Fail-closed proxies:** missing config, an unreachable rate-limit store, or any upstream error returns "unavailable" and never calls the LLM.
- **Bounded AI influence:** the AI only re-scores candidates the rules engine already found. It can adjust a visible match by at most 0.2 either way, or lift a borderline candidate by at most 0.3 to surface an "AI found this" discovery. It cannot go below the 0.25 candidate floor, cannot override hard type gates, and discovered matches can never reach the 0.85 auto-approve threshold.
- **Read-only SQL validator:** every generated query must be a single SELECT or WITH over the loaded tables. Forbidden keywords, file and network functions, and extra statements are rejected.
- **Row caps:** results are bounded so a huge query can never flood the browser, and the on-screen table is capped with a full-result CSV export.

## How we used Kiro

Built spec-first with Kiro. Everything below is checked into the repo.

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

- `frankendata`: our own server (`mcp/`), enabled. See the next section.
- `playwright`: `@playwright/mcp`, disabled by default, for agent-driven browser checks.

**Custom agents** (`.kiro/agents/`, Markdown with front matter)

- `spec-reviewer.md`: read-only review of a spec against the steering docs and the code.
- `security-auditor.md`: read-only audit of a change against `security.md`, the SQL validator and the MCP path guard.

**Tests:** Vitest unit, property (fast-check) and DuckDB golden tests under `npm test`, plus one Playwright browser spec, `e2e/demo.spec.ts`, under `npm run test:e2e`.

We drove each spec through spec-driven task execution, ran the build, tests, lint and the serverless graph check at every checkpoint, and used focused bug-fix prompts for follow-ups. All implementation was done by Kiro agents from the specs.

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

### End-to-end browser test

`npm run test:e2e` (add `E2E_SLOWMO=600` and `-- --headed` to watch it) runs the Playwright spec (`e2e/demo.spec.ts`, two tests) in a real browser against the Vite dev server. It is not part of `npm test`. First run `npx playwright install chromium`. One test loads the mismatched demo, stitches (12 rows), checks the species chip (Swamp Wraith 3), opens the Autopsy on monsters (81), saves a recipe, resets, loads next month's files, applies the recipe and expects 12 rows. The other loads the business demo, stitches (48 rows), checks revenue by region, and opens the CRM Autopsy (79).

For agent-driven browser checks, the Playwright MCP server is registered in `.kiro/settings/mcp.json` but disabled by default. Enable it in the MCP Server view in Kiro, start `npm run dev`, then ask Kiro to open the app and click through the demo.

## Tech stack

- React 19 + Vite + TypeScript
- DuckDB-WASM (in-browser SQL)
- PapaParse (CSV), SheetJS (XLSX)
- Vitest + fast-check (property tests), oxlint
- Vercel serverless functions for the optional `/api/ai` and `/api/sql` proxies
- Upstash Redis for proxy rate limiting and the shared daily cap

## Run locally

```
npm install
npm run dev        # start the Vite dev server
npm test           # run the test suite (vitest)
npm run build      # type-check and production build
npm run check:api  # verify the serverless function graph resolves
```

The app is fully functional with no configuration: with AI off it runs the offline rules engine and the no-AI starter questions. To enable the optional LLM features, set the variables from `.env.example` (names only shown here):

- `VITE_AI_ENABLED` (the only client-visible flag)
- `AI_PROVIDER`, `AI_MODEL`, `OPENAI_API_KEY` (or `AI_API_KEY`), optional `AI_BASE_URL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `IP_HASH_SALT`, optional `ALLOWED_ORIGINS`

## Deployment

See [DEPLOY.md](DEPLOY.md) for Vercel setup, the WASM size caveat, and the manual steps.

## License

MIT
