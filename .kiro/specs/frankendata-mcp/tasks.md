# Implementation Plan: FrankenData MCP Server

## Overview

A local stdio MCP server under `mcp/` that reuses `src/core`. The feasibility proof comes first: the built server must boot over stdio and `load_files` must work on the demo CSVs under Node. Then the path guard, the remaining tools, the property tests, the end-to-end test, and the docs.

**Conventions:**

- Property tests use `fast-check`, one invariant per file, with the property tag in the header comment.
- MCP tests live next to the code under `mcp/`, run under `npm test` with `// @vitest-environment node`.
- No existing `src/core` behavior changes. Tiny additive exports are listed in `NOTES.md`.
- Checkpoints run `npm run build`, `npm run check:api`, and the tests for the touched files.

## Tasks

- [ ] 1. Feasibility proof: boot and load_files (GATE)
  - Add `@modelcontextprotocol/sdk` and `zod` as exact-pinned devDependencies
  - Create `mcp/tsconfig.json`, `mcp/build.mjs`, `mcp/src/node-duckdb.ts`, `mcp/src/session.ts`, a minimal `path-guard.ts`, `errors.ts`, `results.ts`, `limits.ts`, `create-server.ts`, `server.ts`, and the `load_files` tool
  - Create `mcp/fixtures/monsters.csv` and `experiments.csv`
  - Add `mcp:build` and `mcp:start` scripts; ignore `mcp/dist`
  - Smoke test: spawn `node mcp/dist/server.js` over stdio with the SDK client, call `frankendata_load_files` on the fixtures, expect table names, row counts and types
  - If this does not work, stop and write NOTES.md
  - _Design: Build, Node DuckDB, Feasibility gate; Requirements 1, 3, 12.2, 13_
- [ ] 2. Path guard (full)
  - Implement `resolveInput` and `resolveOutput` with symlink handling, relative messages
  - Unit tests: traversal, absolute outside, NUL, empty, symlink file and directory escapes, output folder rules, overwrite and symlink refusal
  - Property 1 test (own file), including generated symlink layouts in a temp directory
  - _Design: Path guard; Requirements 2, 14.1_
- [ ] 3. Error model and result helpers
  - `safe()` wrapper, `invalid-input` mapping, error code set, bigint-safe JSON, row truncation
  - Unit tests for each helper
  - _Design: Error model, Result format; Requirements 11_
- [ ] 4. autopsy and query tools
  - `frankendata_autopsy` (structured report plus Markdown) and `frankendata_query` (validator first, fetch cap, converters)
  - Unit tests per handler for success and every error code
  - Property 2 test: a DuckDB spy sees no call for a rejected statement
  - _Design: Tools; Requirements 4, 8, 14.2_
- [ ] 5. propose_stitch and apply_stitch tools
  - Proposals stored in the session; apply only passed ids; staleness, unknown ids, anchor and key checks
  - Unit tests per handler and error code
  - Property 3 test: originals unchanged for arbitrary approved subsets
  - _Design: Tools; Requirements 5, 6, 14.3_
- [ ] 6. apply_recipe, export and reset tools
  - Recipe replay through the existing validator, mapper and applier; export through `exportTable` and the output guard; reset
  - Unit tests per handler and error code (invalid recipe, not-applied list, file exists, overwrite, symlink target)
  - _Design: Tools; Requirements 7, 9, 10_
- [ ] 7. Checkpoint: `npm run build`, `npm run check:api`, `npm run mcp:build`, the mcp tests; commit
- [ ] 8. Parity and end-to-end tests
  - Property 4: MCP results equal direct core results on the demo files
  - End-to-end test through the SDK in-memory transport (load, autopsy, propose, apply with all ids, query most common species, export CSV)
  - Fixtures test: fixture CSVs equal the bundled demo strings
  - _Design: Correctness properties and tests; Requirements 14.4_
- [ ] 9. Kiro integration and docs
  - `.kiro/settings/mcp.json`, README section "Use FrankenData from Kiro (MCP)" with setup and three example prompts
  - _Requirements: 12_
- [ ] 10. Final checks and notes
  - Run the full test suite, `npm run build`, `npm run lint`, `npm run check:api`, `npm run mcp:build`
  - Write `NOTES.md` and commit
  - _Requirements: all_
