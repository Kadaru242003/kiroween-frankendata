# Deploying FrankenData

FrankenData is a Vite single-page app that runs entirely in the browser on
DuckDB-WASM. It deploys as static files plus one optional serverless function
at `/api/ai` (the AI match-refinement proxy). **The app is fully functional
without the proxy** — with the AI flag off it runs the deterministic, offline
rules engine only.

Target host: **Vercel (Hobby plan)** — static hosting plus a Vercel Function
at `/api/ai`.

## 1. Build and static hosting

| Setting          | Value           |
| ---------------- | --------------- |
| Build command    | `npm run build` |
| Output directory | `dist`          |
| Install command  | `npm install`   |

`vercel.json` already wires this up:

- `rewrites` sends all non-`/api` paths to `/index.html` for SPA routing. The
  source pattern `/((?!api/).*)` uses a negative lookahead so it **never**
  swallows `/api/*` — the serverless function stays reachable. Existing static
  assets (the hashed files under `/assets`, including the `.wasm` bundles) are
  served directly by Vercel before rewrites apply.
- `headers` sets `Content-Type: application/wasm` on `.wasm` responses and a
  long-lived immutable `Cache-Control` on `.wasm` and `/assets/*` (they are
  content-hashed, so caching forever is safe).

### WASM size caveat (Hobby 100 MB limit)

DuckDB-WASM ships two large bundles, `duckdb-eh.wasm` and `duckdb-mvp.wasm`, at
roughly **35–39 MB each**. Vercel's Hobby plan caps a single deployment's
static upload at **100 MB**. Two bundles plus the rest of the app normally fit,
but it is tight.

If the first deploy reports the upload is over 100 MB, ship only the `eh`
(exception-handling) bundle instead of both. That is a build-config change to
the DuckDB bundle selection — not covered by `vercel.json` — so make it in the
app's DuckDB wiring and re-deploy. Modern browsers support the `eh` bundle; the
`mvp` bundle is the broad-compatibility fallback.

### Manual deploy steps

0. **Pre-deploy: run `npm run check:api`.** The `/api/ai` function runs on
   Vercel as native Node ESM, which — unlike Vite and vitest — requires
   explicit file extensions on relative imports (`./types.js`, not
   `./types`). A missing extension throws `ERR_MODULE_NOT_FOUND` at function
   startup in production even though `npm run build` passes. `check:api`
   type-checks the function's import graph with `--module nodenext`
   `--moduleResolution nodenext` (which flags any extensionless relative
   import) and then runs a Node ESM import smoke test of the emitted
   `api/ai.js` in a temp dir, so this class of bug is caught before deploy.
   It makes no network calls and does not invoke the handler.
1. Create or log in to Vercel and import this repository.
2. Confirm the build command / output directory above (Vercel usually detects
   Vite automatically).
3. Run the first deploy.
4. Open the deployed URL and confirm the app loads, the DuckDB `.wasm` files
   are served (DevTools → Network, 200 with `Content-Type: application/wasm`),
   and the total deployment fit under 100 MB. If it did not, apply the
   `eh`-only change above and re-deploy.

At this point the app works end to end in rules-only mode — no further
configuration is required.

## 2. Optional AI proxy (`/api/ai`)

The serverless function in `api/ai.ts` is the only component that touches an
LLM provider and the rate-limit store. It reads **all** configuration from
environment variables at runtime; the LLM API key lives server-side and is
never shipped to the browser. Provider and model are env-driven — there is no
hard-coded model.

To enable AI you need: an LLM provider API key, an Upstash Redis instance (for
rate limiting + the global daily cap), and the client flag turned on.

### Environment variables

See [`.env.example`](./.env.example) for a copy-paste template with
placeholders. Set these in **Vercel → Project → Settings → Environment
Variables** (not in a committed file).

| Variable                   | Scope        | Required for AI | Meaning                                                                                              |
| -------------------------- | ------------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| `VITE_AI_ENABLED`          | Client build | Yes             | Client kill-switch. Only `"true"` attempts AI; anything else (incl. unset) = rules-only, no network. |
| `AI_PROVIDER`              | Server       | Yes             | Which LLM provider the proxy calls, e.g. `openai`.                                                   |
| `AI_MODEL`                 | Server       | Yes             | The model id, e.g. `gpt-4o-mini`. No default — the model is env-driven.                              |
| `OPENAI_API_KEY`           | Server       | Yes             | The LLM API key. Read server-side only. The proxy also accepts `AI_API_KEY` as a fallback name.      |
| `AI_BASE_URL`              | Server       | No              | Override the OpenAI-compatible base URL for compatible providers. Defaults to the OpenAI endpoint.   |
| `UPSTASH_REDIS_REST_URL`   | Server       | Yes             | Upstash Redis REST URL for the rate-limit + daily-cap counters.                                      |
| `UPSTASH_REDIS_REST_TOKEN` | Server       | Yes             | Upstash Redis REST token.                                                                            |
| `IP_HASH_SALT`             | Server       | Yes             | Random salt used to hash the client IP for the per-client limit key. Raw IP is never stored.         |
| `ALLOWED_ORIGINS`          | Server       | No              | Comma-separated origin allow-list for the courtesy Origin check. Empty/unset = check skipped.        |

> The `VITE_` prefix is what exposes `VITE_AI_ENABLED` to the browser bundle at
> build time. Because it is a build-time value, changing it requires a
> re-deploy. Every other variable above is server-side only and never reaches
> the client.

### Fail-closed behavior

The proxy fails closed: if required env is missing, the Upstash counters are
unreachable, or the upstream LLM call errors, it returns an "unavailable"
status and never makes (or bills) an LLM call. The client treats any non-200
identically and falls back to the rules engine, so a misconfigured proxy never
breaks the app.

### Manual AI setup steps

1. **Provision Upstash Redis** via the Vercel Marketplace integration (it can
   inject `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` automatically).
2. **Set the remaining env vars** (`AI_PROVIDER`, `AI_MODEL`, the LLM API key,
   `IP_HASH_SALT`, optionally `AI_BASE_URL` / `ALLOWED_ORIGINS`) and set
   `VITE_AI_ENABLED=true`.
3. **Set a provider-side hard monthly budget** on your LLM account as a
   backstop to the in-proxy per-client limit and global daily cap.
4. **Re-deploy** so the new `VITE_AI_ENABLED` value is baked into the client
   build.
5. **Smoke test**: POST a small request to `/api/ai` and confirm a `200` with a
   `{ "refinements": [...] }` body, then confirm rules-only still works with
   `VITE_AI_ENABLED` off.

## Local development

`vite dev` has no `/api/ai` route — the proxy is a deployed function. In local
dev the app therefore runs rules-only; an AI call would simply 404 and fall
back to the rules engine. Leave `VITE_AI_ENABLED` unset (or `false`) for a
clean offline dev loop. To exercise the function locally, use `vercel dev`,
which serves `api/ai.ts` alongside the Vite app.
