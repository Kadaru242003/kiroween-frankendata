/**
 * PathGuard (Requirement 2): resolves every path before any file system
 * access and accepts it only when its REAL location (symlinks resolved) is
 * inside the allowed root. Output paths must stay inside the output folder.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toolError } from "./errors";
import { MCP_DEFAULT_OUTPUT_DIR } from "./limits";

export interface PathGuardOptions {
  root: string;
  /** Output folder, absolute or relative to the root. */
  outputDir?: string;
}

export interface PathGuard {
  readonly root: string;
  /** Resolve an existing input file. Returns its real path. */
  resolveInput(p: unknown): Promise<string>;
  /** Resolve an output file inside the output folder. */
  resolveOutput(
    name: unknown,
    overwrite: boolean
  ): Promise<{ target: string; relative: string; exists: boolean }>;
  /** A path as shown in messages: relative to the root. */
  display(p: string): string;
  /** The real output directory (not created). */
  outputDir(): Promise<string>;
}

/** True when `target` is `base` or inside it (separator-aware). */
export function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function checkString(p: unknown): string {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
    throw toolError("invalid-path", "The path must be a non-empty string without NUL characters.");
  }
  return p;
}

/** realpath of the deepest existing ancestor plus the missing tail. */
async function realpathOfPossiblyMissing(p: string): Promise<string> {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export async function createPathGuard(options: PathGuardOptions): Promise<PathGuard> {
  const realRoot = await fs.realpath(options.root);
  const outputSetting = options.outputDir ?? MCP_DEFAULT_OUTPUT_DIR;
  const display = (p: string): string => {
    const rel = path.relative(realRoot, p);
    return rel === "" ? "." : rel.startsWith("..") ? "(outside the allowed root)" : rel;
  };

  async function realOutputDir(): Promise<string> {
    const abs = path.resolve(realRoot, outputSetting);
    const real = await realpathOfPossiblyMissing(abs);
    if (!isInside(realRoot, real)) {
      throw toolError("path-outside-root", "The output folder is outside the allowed root.");
    }
    return real;
  }

  return {
    root: realRoot,
    display,
    outputDir: realOutputDir,

    async resolveInput(p: unknown): Promise<string> {
      const input = checkString(p);
      const abs = path.resolve(realRoot, input);
      let real: string;
      try {
        real = await fs.realpath(abs);
      } catch {
        // A missing file: still refuse paths that lexically leave the root.
        if (!isInside(realRoot, await realpathOfPossiblyMissing(abs))) {
          throw toolError("path-outside-root", "The path is outside the allowed root.");
        }
        throw toolError("file-not-found", `File not found: ${display(abs)}`);
      }
      if (!isInside(realRoot, real)) {
        throw toolError("path-outside-root", "The path is outside the allowed root.");
      }
      const stat = await fs.stat(real);
      if (!stat.isFile()) {
        throw toolError("invalid-path", `Not a regular file: ${display(real)}`);
      }
      return real;
    },

    async resolveOutput(name: unknown, overwrite: boolean) {
      const input = checkString(name);
      if (path.isAbsolute(input)) {
        throw toolError("path-outside-root", "Use a file name inside the output folder.");
      }
      const outDir = await realOutputDir();
      const target = path.resolve(outDir, input);
      // The deepest existing ancestor must really be inside the output folder.
      const real = await realpathOfPossiblyMissing(target);
      if (!isInside(outDir, real)) {
        throw toolError("path-outside-root", "The file name is outside the output folder.");
      }
      let exists = false;
      try {
        const st = await fs.lstat(target);
        exists = true;
        if (st.isSymbolicLink()) {
          throw toolError("path-outside-root", "Refusing to write through a symbolic link.");
        }
        if (!st.isFile()) {
          throw toolError("invalid-path", "The target is not a regular file.");
        }
        if (!overwrite) {
          throw toolError(
            "file-exists",
            `${display(target)} already exists. Pass overwrite: true to replace it.`
          );
        }
      } catch (e) {
        if (e instanceof Error && e.name === "ToolError") throw e;
        // lstat failed: the file does not exist yet.
      }
      return { target, relative: display(target), exists };
    },
  };
}
