# FrankenData

Stitch mismatched CSV and XLSX files into one living dataset, then ask it questions in plain English. All in the browser.

Built for the Kiroween 2026 hackathon, Frankenstein category: a mad-scientist lab that bolts together React, DuckDB-WASM, PapaParse, SheetJS, and an optional LLM into one client-side creature.

**Live demo:** https://kiroween-frankendata.vercel.app/

## Try it in 60 seconds

1. Click **Reset lab** (if any tables are already loaded) to start clean.
2. Click **Load mismatched demo** to load two files that describe the same creatures with different headers.
3. Click **Stitch tables**, then **Approve all suggestions**, then **Apply and stitch** to build the cleaned, deduplicated, joined `stitch_1_result` table.
4. In **Ask the Lab**, ask: "which species is most common?"
5. You get back Swamp Wraith with a count of 3, answered from the cleaned stitch result, plus the generated SQL, a bar chart, and a CSV export.

## Features

- **Browser-only engine:** DuckDB-WASM runs entirely client-side, with no server round trip for your data.
- **Typed intake:** CSV (PapaParse) and XLSX (SheetJS) are parsed and type-inferred through messy real-world values (currency, percents, mixed date formats, null tokens).
- **Deterministic rules engine for stitching, with an optional AI enhancement:** each proposal carries an engine badge, and the AI can surface "AI found this" discoveries that the rules alone scored too low to show.
- **Before and after approval screen:** review every match and cleanup as a diff, then approve, reject, or edit (re-pair a match to another column, or change a category's canonical value), with single-step undo. 
- **Ask the Lab:** plain-English questions become DuckDB SQL, rendered as a table with an optional chart and a full CSV export.
- **Starter questions that work with AI off:** deterministic example questions per table run with no LLM call at all.

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

This project was built spec-first with Kiro.

**Specs** (`.kiro/specs`), each with requirements, design, and tasks:
- `frankendata-file-intake`: drag-and-drop CSV/XLSX intake, type inference, DuckDB table loading, and the demo data.
- `frankendata-ai-stitching`: the deterministic rules engine, the approval screen, non-destructive apply and undo, and the optional `/api/ai` enhancement with its safety limits.
- `frankendata-chat-sql`: Ask the Lab, the SQL validator, result conversion and CSV export, hand-built charts, and the `/api/sql` proxy.

**Steering docs** (`.kiro/steering`), loaded in different modes:
- `product.md`, `tech.md`, `structure.md`: product intent, the stack, and the framework-agnostic core structure.
- `security.md` (always on): data-stays-in-browser, fail-closed proxies, no client-visible secrets, SQL validator rules.
- `api-conventions.md` (loads when editing `api/**`): Node handlers, explicit `.js` imports, the shared adapter, `check:api`.
- `testing.md` (loads when editing test files): vitest settings, property tests, golden DuckDB tests.

**Hooks** (`.kiro/hooks`):
- `run-test-suite`: manual full test run.
- `check-api`: manual check that the serverless function graph resolves.
- `pre-commit-quality-gate`: manual build, lint, and test gate.
- `sql-validator-guard`: fires when the SQL validator is edited and re-runs its tests to confirm no safety check was weakened.

We drove each spec through spec-driven task execution in small batches, running the build, tests, lint, and the serverless graph check at each checkpoint, and used focused bug-fix prompts for follow-up issues.

Prompts for the Kiro agent were drafted with help from Claude (Anthropic) outside of Kiro; all implementation was done by Kiro agents from the specs.

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
