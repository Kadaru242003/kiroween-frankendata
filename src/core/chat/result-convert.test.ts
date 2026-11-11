/**
 * Unit tests for safe DuckDB result-value conversion (Feature 3, task 3).
 *
 * Covers design "Result value conversion" and Requirements 7.1–7.4: null,
 * BigInt (safe vs. out of range), Date, DECIMAL shapes, epoch-ms timestamp
 * columns, primitives, and objects/arrays (never [object Object], never throws).
 */

import { describe, expect, it } from "vitest";
import { toDisplayValue, toDisplayRow, toDisplayRows } from "./result-convert";

describe("toDisplayValue", () => {
  it("maps null/undefined to empty string", () => {
    expect(toDisplayValue(null)).toBe("");
    expect(toDisplayValue(undefined)).toBe("");
  });

  it("converts a safe BigInt to a number", () => {
    expect(toDisplayValue(42n)).toBe(42);
    expect(toDisplayValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it("converts an out-of-range BigInt to a decimal string", () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    expect(toDisplayValue(big)).toBe(big.toString());
    expect(typeof toDisplayValue(big)).toBe("string");
  });

  it("converts a Date to an ISO string", () => {
    const d = new Date("2026-10-31T00:00:00.000Z");
    expect(toDisplayValue(d)).toBe("2026-10-31T00:00:00.000Z");
  });

  it("treats a numeric value as epoch-ms only when flagged a timestamp", () => {
    const ms = Date.UTC(2026, 9, 31); // 2026-10-31
    expect(toDisplayValue(ms, true)).toBe(new Date(ms).toISOString());
    // Without the flag, a number stays a number (ordinary numeric column).
    expect(toDisplayValue(ms, false)).toBe(ms);
  });

  it("passes through numbers, booleans, strings", () => {
    expect(toDisplayValue(3.14)).toBe(3.14);
    expect(toDisplayValue(true)).toBe(true);
    expect(toDisplayValue("hi")).toBe("hi");
  });

  it("converts a {value, scale} DECIMAL to a finite number", () => {
    // ROUND(AVG(x), 2) style: unscaled 1234 at scale 2 => 12.34
    expect(toDisplayValue({ value: 1234n, scale: 2 })).toBeCloseTo(12.34, 10);
    expect(toDisplayValue({ unscaled: 500, scale: 2 })).toBeCloseTo(5.0, 10);
    expect(typeof toDisplayValue({ value: 1234n, scale: 2 })).toBe("number");
  });

  it("converts a stringifiable decimal object to a finite number", () => {
    const decimalLike = { toString: () => "7.5" };
    expect(toDisplayValue(decimalLike)).toBeCloseTo(7.5, 10);
  });

  it("never yields [object Object] for a struct/list", () => {
    expect(toDisplayValue({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(toDisplayValue([1, 2, 3])).toBe("[1,2,3]");
    expect(toDisplayValue({ a: 1 })).not.toContain("[object Object]");
  });

  it("stringifies nested bigints inside structs without throwing", () => {
    expect(() => toDisplayValue({ n: 10n })).not.toThrow();
    expect(toDisplayValue({ n: 10n })).toBe('{"n":"10"}');
  });
});

describe("toDisplayRow / toDisplayRows", () => {
  it("projects a row in column order", () => {
    const row = { a: 1n, b: "x", c: null };
    expect(toDisplayRow(row, ["a", "b", "c"])).toEqual([1, "x", ""]);
  });

  it("applies the timestamp-column set", () => {
    const ms = Date.UTC(2026, 0, 1);
    const rows = [{ t: ms, n: ms }];
    const out = toDisplayRows(rows, ["t", "n"], new Set(["t"]));
    expect(out[0][0]).toBe(new Date(ms).toISOString());
    expect(out[0][1]).toBe(ms);
  });
});
