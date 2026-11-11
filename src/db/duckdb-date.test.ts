/**
 * Unit tests for {@link duckDbDateToIso}, the data-layer helper that normalizes
 * DuckDB DATE values (as returned by the browser bundle's Arrow result) into
 * ISO `YYYY-MM-DD` strings.
 *
 * Feature: frankendata-file-intake — DATE preview rendering fix.
 *
 * The browser DuckDB-WASM Arrow result surfaces DATE cells as raw epoch
 * milliseconds (UTC), not Date objects, so the preview was showing numbers like
 * `1767571200000`. These tests pin the conversion across every input shape a
 * DATE cell can arrive as (number ms, Date, bigint, null) and assert the result
 * is timezone-safe (computed from UTC components, never shifting the calendar
 * day).
 */

import { describe, expect, it } from "vitest";
import { duckDbDateToIso } from "./duckdb-service";

describe("duckDbDateToIso", () => {
  // 2026-01-05T00:00:00.000Z — the exact epoch-ms value the reporter observed.
  const JAN_5_2026_MS = Date.UTC(2026, 0, 5);

  it("converts epoch milliseconds (UTC number) to ISO YYYY-MM-DD", () => {
    expect(JAN_5_2026_MS).toBe(1767571200000);
    expect(duckDbDateToIso(1767571200000)).toBe("2026-01-05");
    expect(duckDbDateToIso(Date.UTC(1970, 0, 1))).toBe("1970-01-01");
    expect(duckDbDateToIso(Date.UTC(1999, 11, 31))).toBe("1999-12-31");
  });

  it("converts a Date object using its UTC components", () => {
    expect(duckDbDateToIso(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01-05");
    expect(duckDbDateToIso(new Date(Date.UTC(2000, 1, 29)))).toBe("2000-02-29");
  });

  it("converts bigint epoch milliseconds", () => {
    expect(duckDbDateToIso(BigInt(JAN_5_2026_MS))).toBe("2026-01-05");
    expect(duckDbDateToIso(0n)).toBe("1970-01-01");
  });

  it("leaves NULL/undefined as null", () => {
    expect(duckDbDateToIso(null)).toBeNull();
    expect(duckDbDateToIso(undefined)).toBeNull();
  });

  it("is timezone-safe: a UTC-midnight instant keeps its calendar day", () => {
    // An instant at the very start of the UTC day must render as that same day
    // regardless of the host timezone (UTC getters, not local ones).
    const utcMidnight = new Date(Date.UTC(2026, 0, 5, 0, 0, 0, 0));
    expect(duckDbDateToIso(utcMidnight)).toBe("2026-01-05");
    // And an instant late in the UTC day likewise stays on that day.
    const utcLateInDay = new Date(Date.UTC(2026, 0, 5, 23, 59, 59, 999));
    expect(duckDbDateToIso(utcLateInDay)).toBe("2026-01-05");
  });

  it("zero-pads month and day", () => {
    expect(duckDbDateToIso(Date.UTC(2026, 2, 7))).toBe("2026-03-07");
  });

  it("returns a string already in ISO form unchanged", () => {
    // The node-blocking bundle may surface DATEs as ISO strings; pass through.
    expect(duckDbDateToIso("2026-01-05")).toBe("2026-01-05");
  });

  it("falls back to null for non-finite or unsupported inputs", () => {
    expect(duckDbDateToIso(Number.NaN)).toBeNull();
    expect(duckDbDateToIso(new Date(Number.NaN))).toBeNull();
    expect(duckDbDateToIso({})).toBeNull();
    expect(duckDbDateToIso(true)).toBeNull();
  });
});
