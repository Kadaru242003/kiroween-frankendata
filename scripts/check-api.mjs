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

  rmSync(outDir, { recursive: true, force: true });
  console.log("\n✓ check:api PASSED");
} catch (err) {
  // A module-resolution failure surfaces here as ERR_MODULE_NOT_FOUND; a
  // type/extension error surfaces from tsc's non-zero exit above.
  const msg = err && err.message ? err.message : String(err);
  fail(msg);
}
