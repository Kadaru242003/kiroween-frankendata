/**
 * Property-based test for the Autopsy null percent.
 *
 * Feature: frankendata-autopsy, Property 2: nullPct equals nullCount divided by
 * the row count (zero when the row count is zero).
 *
 * Validates: Requirements 2.1, 9.2
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildColumnFinding } from "./autopsy-engine";

describe("Property 2: null percent equals nulls divided by rows", () => {
  it("holds for arbitrary row and non-null counts", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5_000_000 }),
        fc.nat({ max: 5_000_000 }),
        fc.constantFrom("string", "number", "date", "boolean"),
        (rows, rawNonNull, type) => {
          const nonNull = Math.min(rows, rawNonNull);
          const f = buildColumnFinding({ name: "c", type }, rows, {
            nonNull,
            distinct: Math.min(nonNull, 3),
          });
          const nulls = rows - nonNull;
          expect(f.nullCount).toBe(nulls);
          expect(f.nullPct).toBe(rows === 0 ? 0 : (nulls / rows) * 100);
          expect(f.nullPct).toBeGreaterThanOrEqual(0);
          expect(f.nullPct).toBeLessThanOrEqual(100);
        }
      )
    );
  });
});
