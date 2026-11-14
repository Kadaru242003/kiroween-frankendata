# Variety run notes

## Added

1. **Security fix.** `xlsx` now comes from the official SheetJS tarball (0.20.3). `npm audit` reports 0 vulnerabilities (it was 1 high). No API changes were needed; the xlsx parser, intake, export and MCP tests pass. `DEPLOY.md` explains that Vercel installs it from cdn.sheetjs.com.
2. **Steering.** `design-system.md` (fileMatch `src/components/**`), `mcp-conventions.md` (fileMatch `mcp/**`), `data-engine.md` (fileMatch `src/core/**`), `release-checklist.md` (manual). Content is taken from the real code: tokens and CSS variables from `src/theme/tokens.ts` and `src/index.css`, the real ids and naming, the real MCP safety rules.
3. **Hooks** (same JSON format as the existing ones, `askAgent` actions): `spec-sync` (edit `src/core/**/*.ts`), `a11y-check` (edit `src/components/**/*.tsx`), `mcp-rebuild` (edit `mcp/src/**/*.ts`), `readme-sync` and `demo-smoke` (user triggered). No hook was triggered during the run.
4. **Custom agents.** Kiro documents custom agents for IDE 1.0 (https://kiro.dev/docs/custom-agents/configuration-reference/): Markdown with front matter in `.kiro/agents/`. Added `spec-reviewer.md` (read-only) and `security-auditor.md` (read plus a short list of allowed git commands, writes denied). I could not test them inside the IDE from here, and I did not use fields I could not confirm in that page.
5. **Playwright.** `@playwright/test@1.65.1` (devDependency), `playwright.config.ts` (starts Vite on port 5199), `e2e/demo.spec.ts`, script `npm run test:e2e`. Chromium installed and the spec PASSED in a real browser (about 6 seconds): month one stitch with 12 rows, species chip (Swamp Wraith 3), Autopsy 81, save recipe, reset, next month's files, apply recipe, 12 rows. Not part of `npm test`. The Playwright MCP server (`@playwright/mcp@0.0.85`) is in `.kiro/settings/mcp.json`, disabled, and documented in the README.
6. **README.** "How we used Kiro" now lists every spec, steering doc with inclusion mode, hook with trigger, MCP servers, custom agents and tests, by exact file name.

## Decisions

- The `fileMatchPattern` fields use a single glob string each, matching the existing steering docs. I did not use arrays because I could not confirm array support in this version.
- Hook `spec-sync` matches `src/core/**/*.ts` including test files. It only reports and never edits.
- The Playwright MCP version is pinned to avoid `@latest` drift.
- `e2e/`, `playwright.config.ts`, `test-results/` and `playwright-report/`: the first is committed; the last two are gitignored. Neither is in any tsconfig, so `npm run build` is unaffected.

## Found while testing (not fixed, no app changes allowed)

- **Race after "Reset lab".** `handleResetLab` is asynchronous. If the next demo is loaded before it finishes, the new tables get suffixed names (`monsters_2`) and later steps fail with "Table monsters does not exist". It cannot happen at human click speed, but it is a latent race. The e2e test waits for the previews to disappear before loading again. Suggested fix: disable the demo buttons while a reset is running.
- The e2e test initially matched `Preview of monsters` as a substring of `Preview of monsters_2`; the spec now uses exact matching.

## Skipped

- Nothing was skipped. Powers and skills were not requested.

## Verification

- `npm test` 141 files and 896 tests, `npm run build`, `npm run check:api`, `npm run mcp:build` pass. `npm run lint` has no errors (existing warnings). `npm run test:e2e` passes. `npm audit` 0 vulnerabilities.

## Credits used

About 90 of the 250 budget (an estimate).
