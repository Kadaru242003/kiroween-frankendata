// @vitest-environment node
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
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "frankendata-guard-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "a.csv"), "x\n1\n");
  fs.writeFileSync(path.join(root, "sub", "b.csv"), "x\n1\n");
  fs.writeFileSync(path.join(outside, "secret.csv"), "s\n1\n");
  fs.symlinkSync(path.join(outside, "secret.csv"), path.join(root, "link-file.csv"));
  fs.symlinkSync(outside, path.join(root, "link-dir"));
  fs.symlinkSync(path.join(root, "a.csv"), path.join(root, "link-inside.csv"));
  guard = await createPathGuard({ root });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "other";
  }
};

describe("isInside", () => {
  it("is separator aware", () => {
    expect(isInside("/r", "/r")).toBe(true);
    expect(isInside("/r", "/r/a/b")).toBe(true);
    expect(isInside("/r", "/r2")).toBe(false);
    expect(isInside("/r", "/")).toBe(false);
  });
});

describe("resolveInput", () => {
  it("accepts files inside the root, including a symlink that stays inside", async () => {
    expect(await guard.resolveInput("a.csv")).toBe(path.join(root, "a.csv"));
    expect(await guard.resolveInput("sub/b.csv")).toBe(path.join(root, "sub", "b.csv"));
    expect(await guard.resolveInput("link-inside.csv")).toBe(path.join(root, "a.csv"));
    expect(await guard.resolveInput(path.join(root, "a.csv"))).toBe(path.join(root, "a.csv"));
  });
  it("rejects traversal, absolute paths outside, and symlink escapes", async () => {
    expect(await code(guard.resolveInput("../outside/secret.csv"))).toBe("path-outside-root");
    expect(await code(guard.resolveInput(path.join(outside, "secret.csv")))).toBe("path-outside-root");
    expect(await code(guard.resolveInput("link-file.csv"))).toBe("path-outside-root");
    expect(await code(guard.resolveInput("link-dir/secret.csv"))).toBe("path-outside-root");
    expect(await code(guard.resolveInput("sub/../../outside/secret.csv"))).toBe("path-outside-root");
  });
  it("rejects invalid paths and missing files", async () => {
    expect(await code(guard.resolveInput(""))).toBe("invalid-path");
    expect(await code(guard.resolveInput("a\0.csv"))).toBe("invalid-path");
    expect(await code(guard.resolveInput(42))).toBe("invalid-path");
    expect(await code(guard.resolveInput("sub"))).toBe("invalid-path");
    expect(await code(guard.resolveInput("missing.csv"))).toBe("file-not-found");
    expect(await code(guard.resolveInput("../nope.csv"))).toBe("path-outside-root");
  });
  it("messages do not leak absolute paths", async () => {
    try {
      await guard.resolveInput("missing.csv");
    } catch (e) {
      expect((e as Error).message).not.toContain(root);
    }
  });
});

describe("resolveOutput", () => {
  it("resolves inside the output folder, even before it exists", async () => {
    const out = await guard.resolveOutput("t.csv", false);
    expect(out.target).toBe(path.join(root, "frankendata-output", "t.csv"));
    expect(out.relative).toBe(path.join("frankendata-output", "t.csv"));
    expect(out.exists).toBe(false);
  });
  it("rejects escapes", async () => {
    expect(await code(guard.resolveOutput("../x.csv", false))).toBe("path-outside-root");
    expect(await code(guard.resolveOutput(path.join(outside, "x.csv"), false))).toBe("path-outside-root");
    expect(await code(guard.resolveOutput("", false))).toBe("invalid-path");
  });
  it("refuses overwrite without the flag and symlink targets", async () => {
    const dir = path.join(root, "frankendata-output");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "e.csv"), "x");
    expect(await code(guard.resolveOutput("e.csv", false))).toBe("file-exists");
    expect((await guard.resolveOutput("e.csv", true)).exists).toBe(true);
    fs.symlinkSync(path.join(outside, "secret.csv"), path.join(dir, "s.csv"));
    expect(await code(guard.resolveOutput("s.csv", true))).toBe("path-outside-root");
    fs.symlinkSync(outside, path.join(dir, "ld"));
    expect(await code(guard.resolveOutput("ld/new.csv", true))).toBe("path-outside-root");
  });
  it("rejects an output folder outside the root", async () => {
    const g = await createPathGuard({ root, outputDir: "../outside" });
    expect(await code(g.resolveOutput("x.csv", false))).toBe("path-outside-root");
  });
});
