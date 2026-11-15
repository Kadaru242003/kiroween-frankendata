# Continuous integration: run notes

Branch `ci`, cut from `main`. Not merged.

## What was added

| File | What it is |
| --- | --- |
| `.github/workflows/ci.yml` | The CI job: on push to `main` and on every pull request. |
| `.github/workflows/kiro-review.yml` | Optional Kiro CLI security review of a pull request diff. Skipped cleanly without a key. |
| `.nvmrc` | Pins Node to `24.16.0`. |
| `playwright.config.ts` | One line: the HTML reporter is added only when `CI` is set, so there is a report to upload. Local runs are unchanged. |
| `README.md` | A CI badge under the title and a "Continuous integration" section. |

## ci.yml

- **Triggers**: `push` to `main` and `pull_request`. A newer push to the same branch or pull request cancels a run in progress (`concurrency`). `permissions: contents: read` only.
- **One job**, `ubuntu-latest`, 30 minute timeout. Steps, in order, each its own named step so the first red one names the gate:
  1. check out, `actions/setup-node@v4` with `node-version-file: .nvmrc` and `cache: npm`, `npm ci`
  2. "Confirm AI is off": fails if `VITE_AI_ENABLED` is set in the environment
  3. Gate 1 `npm run lint`
  4. Gate 2 `npm test`
  5. Gate 3 `npm run build`
  6. Gate 4 `npm run check:api`
  7. Gate 5 `npm run mcp:build`
  8. `npx playwright install --with-deps chromium` (Chromium only, with the system libraries)
  9. Gate 6 `npm run test:e2e`
  10. on failure, upload `playwright-report/` and `test-results/` (traces are kept on failure by the existing config) as the `playwright-report` artifact, 14 days
- **No secrets, AI off**: the workflow reads no secret and never sets `VITE_AI_ENABLED`, which is also guarded by step 2. `.env` is gitignored, so a clean runner has none. The app and the tests therefore run fully local.
- **Action versions** are pinned by major tag (`@v4`), not by commit SHA. Pinning to SHAs is stricter and is a reasonable follow-up.
- **Node pin**: neither `.nvmrc` nor `engines` existed, so I added `.nvmrc` with the exact version this repo was verified on. I did not add `engines` to `package.json`: Vercel reads `engines.node` to choose its runtime, so adding it would change deployment behavior, which was outside this task.

## Checked locally

A fresh clone of the branch in `/tmp` (no `node_modules`, no `.env`, no `mcp/dist`, no `dist`), with `CI=true` and `VITE_AI_ENABLED` unset, running the workflow's commands in the same order:

| Step | Result |
| --- | --- |
| `npm ci` | passed |
| lint | passed (warnings only, exit 0) |
| `npm test` | 202 files, 1335 tests passed (236 seconds) |
| build | passed |
| `check:api` | passed |
| `mcp:build` | passed |
| `npx playwright install chromium` | passed |
| `npm run test:e2e` | 24 passed (76 seconds), and `playwright-report/index.html` was written |

That run also proves the unit tests do not depend on `mcp/dist` already existing (the stdio smoke test builds it when missing).

**Not checked, and why**

- The workflow has not run on GitHub: it only runs once the branch is pushed. The YAML of both files was parsed locally, and I read the steps against the Actions syntax, but `actionlint` was not available.
- `playwright install --with-deps` installs system packages with `apt`, so it is Linux only. This machine is macOS, so the plain `install chromium` was run instead.
- Runner speed. On GitHub's shared runners the 236 second unit test step and the 76 second e2e step will likely be slower. The DuckDB tests run one file at a time on purpose (`fileParallelism: false`), so more cores will not help. The job limit is 30 minutes.
- The badge shows "no status" until the first run. It points at `github.com/Kadaru242003/kiroween-frankendata` (the `origin` remote). If the repository is renamed or private, update the URL.
- Branch protection: to make CI block merges, mark the `Lint, test, build, end to end` check as required in the repository settings. That is a GitHub setting, not something a file can do.
- One earlier run on another branch saw `stitch-applier.undo.property.test.ts` take far longer than usual once (see `.kiro/NOTES-security-hardening.md`). It has not repeated. If CI shows it, look there first.

## Optional: Kiro CLI review (`kiro-review.yml`)

### What the official docs say (checked)

Source: the Kiro CLI "Headless mode" page, https://kiro.dev/docs/cli/headless/, and the exit codes page, https://kiro.dev/docs/reference/exit-codes/. From them:

- Headless mode runs the CLI in CI "with no interactive terminal". It needs an API key in the `KIRO_API_KEY` environment variable, and a non-empty instruction passed with `--no-interactive`, either as an argument or piped on stdin.
- The docs ship a GitHub Actions example that installs the CLI with `curl -fsSL https://cli.kiro.dev/install | bash`, passes the secret as `KIRO_API_KEY`, and runs `kiro-cli chat --v3 --no-interactive --trust-tools=read_file,grep_search "..."` on `pull_request`.
- With nobody to approve tool calls, tools must be trusted in advance. The docs prefer `--trust-tools` with an explicit list over `--trust-all-tools`, and recommend naming the harness (`--v3`) in every headless command.
- Exit code 0 is success, 1 a general failure (including auth), 3 an MCP startup failure (only with `--require-mcp-startup`), 4 a named `--agent` that is not available.
- `KIRO_API_KEY` must be stored as a CI secret, never in the repository.

### Decision: added, with one deliberate difference from "run the agent"

It needs only things the docs cover, so it was added. It does not use `--agent security-auditor`. Our `.kiro/agents/security-auditor.md` is the IDE's Markdown format. The docs say a named agent that is not available makes a non-interactive run exit 4, and that on V3 an agent that exists only in the older (V2) format counts as unavailable. I could not confirm from the docs that the Markdown file loads as a CLI agent, and I did not want a review that dies on exit 4. So the workflow takes the agent's instructions (the file without its front matter) and passes them as the prompt, together with the diff. The review follows the same checklist, but through the CLI's own tools rather than the agent definition's `tools` and `permissions`.

### What the workflow does

1. **Gate on the key.** The first step checks whether the `KIRO_API_KEY` secret is non-empty. If it is empty, it writes "Skipped" to the job summary, prints a notice, and every later step is skipped (`if: steps.gate.outputs.enabled == 'true'`). The job ends green. Secrets cannot be read in a job-level `if`, which is why the check is a step. On a pull request from a fork GitHub withholds secrets, so those runs skip the same way, which is also the safe behavior.
2. **Check out** with full history, **install the CLI** with the documented command, and add `~/.local/bin` to `PATH` (the docs' example calls `kiro-cli` in a later step, which implies it is on `PATH`; adding it is harmless).
3. **Build the prompt**: a short task header, the agent instructions, and `git diff origin/<base>...HEAD` (excluding `package-lock.json`, cut to 150000 bytes). The base branch name goes through an environment variable, not into the script text. The header says the diff is untrusted data to review and not instructions, and tells the model to read the three steering files the agent normally loads.
4. **Run** `kiro-cli chat --v3 --no-interactive --trust-tools=read_file,grep_search < prompt.md`. Only reading and searching are trusted, so a diff that tries to inject instructions cannot write files or run commands.
5. **Post** the output to `$GITHUB_STEP_SUMMARY` (cut to 900000 bytes, under the 1 MiB summary limit). If the CLI exits non-zero (a bad key, for example) the summary shows the exit code and the last lines of stderr, and the job fails, so a broken key is visible. The workflow is not part of `ci.yml`, so it does not block the main gates unless you mark it required.

### What you need to turn it on

- A Kiro account on a plan that can generate API keys (for an organization, an admin may first have to allow it in the Kiro console). I could not verify the exact plan names or what a run costs, so check that before you rely on it. It is not a new service if you already pay for Kiro, and nothing runs and nothing is charged until the secret exists.
- Create the key in your Kiro account settings (the docs link "Generate an API key" from the headless page). It is shown once.
- Add it as the repository secret `KIRO_API_KEY` (Settings, Secrets and variables, Actions).

### Not verified

- The workflow was not run: there is no key here and it only runs on GitHub. The commands and flags are the ones in the official example, but the first real run may show something small (for example, how much progress text the CLI prints to stdout besides the review, which would land in the summary).
- That `read_file` and `grep_search` are the right tool IDs for the CLI version the installer fetches. They are the IDs in the docs' own example.
- The glibc requirement for the CLI on Linux (reported as 2.39 or newer by a third-party summary, not on the pages I fetched). `ubuntu-latest` is Ubuntu 24.04, which meets that.
- Whether the Markdown agent could be loaded directly as a CLI agent. The docs mention converting older agents with `kiro-cli agent upgrade <directory>`, which I did not try, so the instructions are passed in the prompt instead.

## No em dashes

None in the workflows, `.nvmrc`, the README changes or this note.
