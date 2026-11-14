/**
 * Unit tests for idempotent demo loading (bug fix: repeated demo reloads).
 *
 * The loader loads each demo at most once (by id) until cleared, so repeated
 * clicks never pile up duplicate tables. Both demos are independently loadable;
 * `clear()` (called on reset) re-enables every demo.
 */

import { describe, expect, it, vi } from "vitest";
import { createDemoLoader, type DemoId } from "./demo-loader";

function setup() {
  const intake = vi.fn(async () => {});
  const defaultFiles = vi.fn(async () => [new File(["a"], "monsters.csv")]);
  const mismatchedFiles = vi.fn(async () => [new File(["b"], "monsters.csv")]);
  const loader = createDemoLoader({
    providers: {
      default: defaultFiles,
      mismatched: mismatchedFiles,
      nextMonth: async () => [],
    },
    intake,
  });
  return { loader, intake, defaultFiles, mismatchedFiles };
}

describe("createDemoLoader", () => {
  it("loads a demo once; a second load is a no-op", async () => {
    const { loader, intake, defaultFiles } = setup();
    expect(loader.isLoaded("default")).toBe(false);

    expect(await loader.load("default")).toBe(true);
    expect(loader.isLoaded("default")).toBe(true);
    expect(intake).toHaveBeenCalledTimes(1);

    // Second click: no new intake, no new tables.
    expect(await loader.load("default")).toBe(false);
    expect(intake).toHaveBeenCalledTimes(1);
    expect(defaultFiles).toHaveBeenCalledTimes(1);
  });

  it("still loads the OTHER demo after one is loaded", async () => {
    const { loader, intake } = setup();
    await loader.load("default");
    expect(await loader.load("mismatched")).toBe(true);
    expect(loader.isLoaded("mismatched")).toBe(true);
    expect(intake).toHaveBeenCalledTimes(2);
  });

  it("re-enables a demo after clear() (reset)", async () => {
    const { loader, intake } = setup();
    await loader.load("default");
    loader.clear();
    expect(loader.isLoaded("default")).toBe(false);
    expect(await loader.load("default")).toBe(true);
    expect(intake).toHaveBeenCalledTimes(2);
  });

  it("does not mark a demo loaded when intake fails (retryable), never throws", async () => {
    const intake = vi.fn(async () => {
      throw new Error("intake boom");
    });
    const loader = createDemoLoader({
      providers: {
        default: async () => [new File(["a"], "monsters.csv")],
        mismatched: async () => [],
        nextMonth: async () => [],
      },
      intake,
    });
    await expect(loader.load("default")).resolves.toBe(false);
    expect(loader.isLoaded("default")).toBe(false);
  });

  it("loads each id independently", async () => {
    const { loader } = setup();
    const ids: DemoId[] = ["default", "mismatched"];
    for (const id of ids) expect(await loader.load(id)).toBe(true);
    for (const id of ids) expect(loader.isLoaded(id)).toBe(true);
  });
});
