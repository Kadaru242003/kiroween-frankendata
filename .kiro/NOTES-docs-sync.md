# Docs sync notes

## What was done

1. **Spec sync.** Appended an "Implementation notes and deviations" section to the `design.md` of all seven specs (file-intake, ai-stitching, chat-sql, autopsy, recipes, mcp, smarter-ask), based on the code and tests. Requirements were not rewritten. `frankendata-chat-sql/requirements.md` got a short "Implementation status notes" footer (line charts later built, pie charts not built). `tasks.md`: all MCP tasks marked done; file-intake optional 18.3 and 18.4 marked done (their tests exist); the optional file-intake tasks 14.4, 15.2, 16.2, 19.2, 19.3, the ai-stitching theme polish task 24, and chat-sql 13.* (PieChart) stay unchecked with a note.
2. **README.** Rewrote "Try it in 60 seconds" (it now uses only the starter question, so it works with AI off), added "Try the recipe flow" and "Try a follow-up question", rewrote Features for everything shipped, added "By the numbers", and added the smarter-ask spec to the "How we used Kiro" table. The rest of that section was already accurate (steering inclusion modes, hooks with triggers, agents, MCP servers).
3. **Counts** (from a real run): 7 specs, 10 steering docs, 9 hooks, 2 custom agents, 2 MCP servers (frankendata enabled, playwright disabled), 156 test files with 960 tests passing (63 property-test files), 1 Playwright spec. `npm run build` passes.

## Decisions

- Deviations are appended as dated-neutral sections instead of editing the original design text, so the history of the plan stays visible.
- Existing specs and steering contain older em dashes; they were left alone. Nothing added in this run contains an em dash.
- The "60 seconds" path no longer asks the AI question ("which species is most common?"), because that needs the proxy. It moved to the follow-up section, labeled as AI on.
- No code under `src/`, `api/` or `mcp/` was changed.

## Known gaps

- The file-intake and ai-stitching designs are long; only the differences are listed, not every interface re-checked line by line.
- The `.kiro/specs/*/tasks.meta.json` files were not touched.

## Credits used

About 45 of the 120 budget (an estimate).
