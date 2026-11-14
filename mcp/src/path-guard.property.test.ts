// @vitest-environment node
/**
 * Feature: frankendata-mcp, Property 1: the path guard never accepts a path
 * outside the root (traversal, absolute paths, NUL bytes, symlinks).
 */
import fc from "fast-check";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPathGuard, isInside, type PathGuard } from "./path-guard";

let base: string;
let root: string;
let outside: string;
let guard: PathGuard;

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "frankendata-guardprop-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(path.join(root, "frankendata-output"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "a.csv"), "x");
  fs.writeFileSync(path.join(outside, "secret.csv"), "s");
  fs.symlinkSync(path.join(outside, "secret.csv"), path.join(root, "link-file.csv"));
  fs.symlinkSync(outside, path.join(root, "link-dir"));
  fs.symlinkSync(outside, path.join(root, "frankendata-output", "out-link"));
  guard = await createPathGuard({ root });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const segment = fc.constantFrom(
  "..", ".", "a.csv", "sub", "link-file.csv", "link-dir", "secret.csv", "out-link",
  "frankendata-output", "outside", "root", "", "x\0y", "%2e%2e", "....", "..\\"
);
const candidate = () =>
  fc
  .tuple(
    fc.constantFrom("", "/", path.join(base, "root") + "/", path.join(base, "outside") + "/", base + "/"),
    fc.array(segment, { maxLength: 6 })
  )
  .map(([prefix, segs]) => prefix + segs.join("/"));

describe("Feature: frankendata-mcp, Property 1: path guard", () => {
  it("never accepts an input path whose real location is outside the root", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(candidate(), fc.string({ unit: "binary", maxLength: 20 })), async (p) => {
        try {
          const real = await guard.resolveInput(p);
          expect(isInside(guard.root, real)).toBe(true);
          expect(fs.realpathSync(real)).toBe(real);
        } catch (e) {
          expect(typeof (e as { code?: string }).code).toBe("string");
        }
      }),
      { numRuns: 300 }
    );
  });

  it("never returns an output target outside the output folder", async () => {
    const outDir = path.join(guard.root, "frankendata-output");
    await fc.assert(
      fc.asyncProperty(fc.oneof(candidate(), fc.string({ unit: "binary", maxLength: 20 })), fc.boolean(), async (p, ow) => {
        try {
          const out = await guard.resolveOutput(p, ow);
          const real = path.join(fs.realpathSync(path.dirname(out.target)), path.basename(out.target));
          expect(isInside(outDir, real)).toBe(true);
        } catch (e) {
          expect(typeof (e as { code?: string }).code).toBe("string");
        }
      }),
      { numRuns: 300 }
    );
  });
});
