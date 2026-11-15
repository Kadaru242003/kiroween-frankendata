import { describe, expect, it } from "vitest";
import { loadControlsEnabled, ResetLock } from "./reset-lock";

describe("ResetLock", () => {
  it("is busy while running and releases after", async () => {
    const lock = new ResetLock();
    let release!: () => void;
    const p = lock.run(() => new Promise<void>((r) => (release = r)));
    expect(lock.isBusy()).toBe(true);
    expect(loadControlsEnabled(lock.getState())).toBe(false);
    release();
    expect(await p).toBe(true);
    expect(lock.isBusy()).toBe(false);
  });
  it("coalesces a second reset", async () => {
    const lock = new ResetLock();
    let release!: () => void;
    let runs = 0;
    const first = lock.run(() => { runs++; return new Promise<void>((r) => (release = r)); });
    expect(await lock.run(async () => { runs++; })).toBe(false);
    release();
    await first;
    expect(runs).toBe(1);
  });
  it("releases when the reset throws", async () => {
    const lock = new ResetLock();
    await expect(lock.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(lock.isBusy()).toBe(false);
  });
  it("notifies subscribers", async () => {
    const lock = new ResetLock();
    const seen: boolean[] = [];
    lock.subscribe(() => seen.push(lock.isBusy()));
    await lock.run(async () => {});
    expect(seen).toEqual([true, false]);
  });
});
