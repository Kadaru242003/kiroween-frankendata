/**
 * Property-based tests for {@link checkSize} (file size validation guard).
 *
 * Feature: frankendata-file-intake, Property 7: File size limit enforcement
 *
 * Validates: Requirements 2.3
 *
 * Property statement (design.md Property 7): For any file whose size exceeds
 * 25 MB, the file is skipped and an error names the file and states the 25 MB
 * limit; for any file at or below 25 MB, no size error is produced.
 *
 * The boundary is driven by the exported {@link MAX_FILE_SIZE_BYTES} constant
 * rather than hardcoded, so the test stays in lockstep with the module.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_FILE_SIZE_BYTES, checkSize } from "./check-size";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/** Arbitrary, possibly-messy file names (incl. empty / symbol-laden). */
const fileNameArb = fc.string();

describe("checkSize — Property 7: File size limit enforcement", () => {
  it("produces no size error for any file at or below 25 MB (including the exact boundary)", () => {
    fc.assert(
      fc.property(
        // Sizes within [0, MAX] inclusive — the boundary itself is within limit.
        fc.integer({ min: 0, max: MAX_FILE_SIZE_BYTES }),
        fileNameArb,
        (size, fileName) => {
          expect(checkSize(size, fileName)).toBeNull();
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("skips any file larger than 25 MB with an error naming the file and stating the 25 MB limit", () => {
    fc.assert(
      fc.property(
        // Strictly greater than the limit.
        fc.integer({
          min: MAX_FILE_SIZE_BYTES + 1,
          max: Number.MAX_SAFE_INTEGER,
        }),
        fileNameArb,
        (size, fileName) => {
          const error = checkSize(size, fileName);

          expect(error).not.toBeNull();
          // Narrow for the type checker after the null assertion above.
          if (error === null) {
            throw new Error("expected an oversized IntakeError");
          }

          expect(error.kind).toBe("oversized");
          expect(error.stage).toBe("validation");
          expect(error.sourceFileName).toBe(fileName);
          // The message names the file and references the 25 MB limit.
          expect(error.message).toContain(fileName);
          expect(error.message).toContain("25 MB");
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
