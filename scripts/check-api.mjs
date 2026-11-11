/**
 * check:api — prove the Vercel serverless function graph resolves under REAL
 * Node ESM rules (the deployed function runs as native Node ESM, which requires
 * explicit file extensions on relative imports).
 *
 * Two stages:
 *   1. Type-check `api/ai.ts` + its runtime graph with `--module nodenext
 *      --moduleResolution nodenext` (via tsconfig.api.json). Under nodenext,
 *      tsc ERRORS on any extensionless relative import — so a regression that
 *      drops a `.js` extension fails this check. tsc also EMITS the graph to a
 *      temp dir OUTSIDE the repo.
 *   2. Node ESM import smoke test: dynamically `import()` the emitted
 *      `api/ai.js` to confirm it loads without ERR_MODULE_NOT_FOUND. It ONLY
 *      imports the module (asserts a default export exists); it never calls the
 *      handler and makes no network request.
 *
 * No esbuild / npx esbuild is used (it hung in this environment). Cleanup uses
 * fs.rm, never a shell `rm -rf`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const repoRoot = process.cwd();
// Temp dir OUTSIDE the repo (OS temp), so no in-repo artifact is produced.
const outDir = mkdtempSync(join(tmpdir(), "frankendata-api-check-"));

function fail(msg) {
  console.error(`\n✗ check:api FAILED: ${msg}`);
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  process.exit(1);
}

try {
  // ── Stage 1: nodenext type-check + emit ────────────────────────────────────
  console.log(
    "check:api → type-checking api/ai.ts graph with --module nodenext " +
      "--moduleResolution nodenext (flags extensionless relative imports)…"
  );
  // Local tsc binary (no npx network fetch).
  const tscBin = join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc"
  );
  execFileSync(
    tscBin,
    ["-p", "tsconfig.api.json", "--outDir", outDir],
    { cwd: repoRoot, stdio: "inherit" }
  );
  console.log("  ✓ nodenext type-check passed (no extensionless imports).");

  // Node must treat the emitted .js as ESM: drop a type:module package.json.
  writeFileSync(
    join(outDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2)
  );

  // ── Stage 2: Node ESM import smoke test ─────────────────────────────────────
  const emittedEntry = join(outDir, "api", "ai.js");
  if (!existsSync(emittedEntry)) {
    fail(`expected emitted entry not found: ${emittedEntry}`);
  }
  console.log(
    "check:api → Node ESM import smoke test of the emitted api/ai.js " +
      "(load only; no handler call, no network)…"
  );
  const mod = await import(pathToFileURL(emittedEntry).href);
  if (typeof mod.default !== "function") {
    fail("emitted api/ai.js loaded but has no default handler export");
  }
  console.log("  ✓ emitted api/ai.js imported cleanly (no ERR_MODULE_NOT_FOUND).");

  // ── Stage 3: Node (req, res) invocation smoke test ─────────────────────────
  // Call the default export the way Vercel's Node runtime does — with a
  // Node-style readable `req` and a `ServerResponse`-like `res` — for the body
  // "{}". This is the check that catches `req.text is not a function`: a web-
  // Request-assuming handler throws here. We assert it RESOLVES and writes a
  // 400 (schema) or 503 (fail-closed) status, never throwing. No env/secret is
  // set, so it fails closed and contacts no provider / makes no network call.
  console.log(
    "check:api → Node (req, res) invocation smoke test (body \"{}\"; " +
      "expects 400 or 503, no throw, no network)…"
  );
  const req = Object.assign(Readable.from([Buffer.from("{}", "utf8")]), {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  let statusCode = 0;
  let ended = false;
  const res = {
    statusCode: 0,
    setHeader() {},
    end() {
      statusCode = this.statusCode;
      ended = true;
    },
  };
  await mod.default(req, res);
  if (!ended) {
    fail("handler returned without writing a response (res.end not called)");
  }
  if (statusCode !== 400 && statusCode !== 503) {
    fail(
      `handler responded with unexpected status ${statusCode} ` +
        "(expected 400 schema or 503 fail-closed)"
    );
  }
  console.log(
    `  ✓ handler invoked as (req, res) and responded ${statusCode} ` +
      "without throwing (no req.text crash)."
  );

  // ── Stage 4: same ESM import + (req, res) smoke for api/sql.js ─────────────
  // The SqlProxy entrypoint (Feature 3) shares the Node adapter via
  // api/_shared.ts and must resolve + run under the same real Node ESM rules.
  const sqlEntry = join(outDir, "api", "sql.js");
  if (!existsSync(sqlEntry)) {
    fail(`expected emitted entry not found: ${sqlEntry}`);
  }
  console.log(
    "check:api → Node ESM import smoke test of the emitted api/sql.js " +
      "(load only; no handler call, no network)…"
  );
  const sqlMod = await import(pathToFileURL(sqlEntry).href);
  if (typeof sqlMod.default !== "function") {
    fail("emitted api/sql.js loaded but has no default handler export");
  }
  console.log("  ✓ emitted api/sql.js imported cleanly (no ERR_MODULE_NOT_FOUND).");

  console.log(
    "check:api → Node (req, res) invocation smoke test for api/sql.js " +
      "(body \"{}\"; expects 400 or 503, no throw, no network)…"
  );
  const sqlReq = Object.assign(Readable.from([Buffer.from("{}", "utf8")]), {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  let sqlStatus = 0;
  let sqlEnded = false;
  const sqlRes = {
    statusCode: 0,
    setHeader() {},
    end() {
      sqlStatus = this.statusCode;
      sqlEnded = true;
    },
  };
  await sqlMod.default(sqlReq, sqlRes);
  if (!sqlEnded) {
    fail("api/sql handler returned without writing a response (res.end not called)");
  }
  if (sqlStatus !== 400 && sqlStatus !== 503) {
    fail(
      `api/sql handler responded with unexpected status ${sqlStatus} ` +
        "(expected 400 schema or 503 fail-closed)"
    );
  }
  console.log(
    `  ✓ api/sql handler invoked as (req, res) and responded ${sqlStatus} ` +
      "without throwing (no req.text crash)."
  );

  rmSync(outDir, { recursive: true, force: true });
  console.log("\n✓ check:api PASSED");
} catch (err) {
  // A module-resolution failure surfaces here as ERR_MODULE_NOT_FOUND; a
  // type/extension error surfaces from tsc's non-zero exit above.
  const msg = err && err.message ? err.message : String(err);
  fail(msg);
}
