---
inclusion: fileMatch
fileMatchPattern: 'api/**'
---

# Serverless function conventions

Rules for the code under `api/` (the only server-side code in the project).

## Thin Node (req, res) handlers

- Each entrypoint (`api/ai.ts`, `api/sql.ts`) is a thin default-export handler invoked by Vercel's Node runtime as `(req, res)`, where `req` is a Node IncomingMessage-like readable stream (not a web `Request`, so there is no `.text()`) and `res` is a ServerResponse-like writable.
- The entrypoint only decodes the request, reads `process.env`, builds the real clients, and delegates every decision to a framework-agnostic core handler (`src/core/stitching/ai-proxy.ts` for `/api/ai`, `src/core/chat/sql-proxy.ts` for `/api/sql`). Keep all logic in the core handler so it stays unit-testable with mocked Redis and a mocked upstream.

## Shared helpers

- The shared Node adapter plumbing (body streaming with a hard byte cap, the Upstash REST client, the OpenAI-compatible LLM client, header and client-IP helpers) lives in `api/_shared.ts` and is imported by both entrypoints. Do not duplicate it per entrypoint.

## Node ESM import rules

- The api graph is type-checked under `--module nodenext --moduleResolution nodenext`, so every relative import in files reachable from `api/` MUST use an explicit `.js` extension (for example `../src/core/chat/sql-proxy.js`).
- When you add a new file to the api graph, add it to the `include` list in `tsconfig.api.json`.
- `npm run check:api` must pass. It type-checks the graph under nodenext, imports the emitted entrypoints, and invokes them as `(req, res)`. Run it after any change under `api/` or to a module they import.

## Error codes and behavior

- Both proxies return the same status codes for the same conditions: 400 (schema violation), 403 (disallowed origin), 405 (non-POST), 413 (payload too large), 429 (per-client limit or shared daily cap), 503 (fail-closed unavailable).
- The ordered, fail-closed checks are: method, required env, payload size, strict schema, origin, per-client hourly counter, shared daily cap, then the upstream call. Never call the LLM if any counter cannot be read.
- Extracting or refactoring shared code must not change `/api/ai` behavior: the existing `api/ai.test.ts` and the `src/core/stitching` proxy tests must keep passing unchanged, and `npm run check:api` must still pass.
