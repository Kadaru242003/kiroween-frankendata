# FrankenData

Stitch mismatched CSV and XLSX files into one living dataset, then ask it questions in plain English. All in the browser.

Built for the Kiroween 2026 hackathon, Frankenstein category: a mad-scientist lab that bolts together React, DuckDB-WASM, PapaParse, SheetJS, and an optional LLM into one client-side creature.

**Live demo:** https://kiroween-frankendata.vercel.app/

## Try it in 60 seconds

1. Click **Reset lab** (if any tables are already loaded) to start clean.
2. Click **Load mismatched demo** to load two files that describe the same creatures with different headers.
3. Click **Stitch tables**, then **Approve all suggestions**, then **Confirm & stitch**, then **Apply & stitch** in the Join panel to build the cleaned, deduplicated, joined `stitch_1_result` table. Use **Undo stitch** to reverse it.
4. In **Ask the Lab**, ask: "which species is most common?"
5. You get back Swamp Wraith with a count of 3, answered from the cleaned stitch result, plus the generated SQL and a CSV export. Then click the starter question "How many rows per Species in stitch_1_result?" to get a bar chart.

## Features

- **Browser-only engine:** DuckDB-WASM runs entirely client-side, with no server round trip for your data.
- **Typed intake:** CSV (PapaParse) and XLSX (SheetJS) are parsed and type-inferred through messy real-world values (currency, percents, mixed date formats, null tokens).
- **Deterministic rules engine for stitching, with an optional AI enhancement:** each proposal carries an engine badge, and the AI can surface "AI found this" discoveries that the rules alone scored too low to show.
- **Before and after approval screen:** review every match and cleanup as a diff, then approve, reject, or edit (re-pair a match to another column, or change a category's canonical value), with single-step undo. 
- **Ask the Lab:** plain-English questions become DuckDB SQL, rendered as a table with an optional chart and a full CSV export.
- **Starter questions that work with AI off:** deterministic example questions per table run with no LLM call at all.
- **Little Frank:** a mascot stitched together from spreadsheet cells who reacts to every step: asleep until you load data, alive after a lightning strike, goggles while you review, bandages when you stitch, a chart when you get an answer. Click him to poke him.

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

We drove each spec through spec-driven task execution, ran the build, tests, lint and the serverless graph check at every checkpoint, and used focused bug-fix prompts for follow-ups. Prompts for the Kiro agent were drafted with help from Claude (Anthropic) outside of Kiro; all implementation was done by Kiro agents from the specs.

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

`npm run test:e2e` runs one Playwright spec (`e2e/demo.spec.ts`) in a real browser against the Vite dev server. It is not part of `npm test`. First run `npx playwright install chromium`. The spec loads the mismatched demo, stitches with all suggestions (12 rows), checks the species chip (Swamp Wraith 3), opens the Autopsy on monsters (81), saves a recipe, resets, loads next month's files, applies the recipe and expects 12 rows.

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
