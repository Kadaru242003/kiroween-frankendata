import { describe, expect, it } from "vitest";
import { FRANK_CALM_STORAGE_KEY } from "./constants";
import { readCalm, writeCalm, type CalmStorage } from "./calm";

function memory(): CalmStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const throwing: CalmStorage = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("quota");
  },
};

describe("Calm Frank preference", () => {
  it("round-trips under the documented key", () => {
    const s = memory();
    expect(readCalm(s)).toBe(false);
    writeCalm(true, s);
    expect(s.data.get(FRANK_CALM_STORAGE_KEY)).toBe("1");
    expect(readCalm(s)).toBe(true);
    writeCalm(false, s);
    expect(readCalm(s)).toBe(false);
  });
  it("never throws when storage throws or is missing", () => {
    expect(() => writeCalm(true, throwing)).not.toThrow();
    expect(readCalm(throwing)).toBe(false);
    expect(() => writeCalm(true, null)).not.toThrow();
    expect(readCalm(null)).toBe(false);
  });
  it("uses the real localStorage by default", () => {
    writeCalm(true);
    expect(readCalm()).toBe(true);
    writeCalm(false);
    expect(readCalm()).toBe(false);
  });
});
