/**
 * Property-based tests for {@link CsvParser} error detection.
 *
 * Feature: frankendata-file-intake
 *
 * Property 3: Empty file detection (CSV portion)
 * Property 4: Unreadable file detection (CSV portion)
 *
 * Validates: Requirements 3.2, 3.3
 *
 * Property statements (design.md):
 *  - Property 3: For any CSV with zero data rows, the system reports an
 *    empty-file error that names the file.
 *  - Property 4: For any CSV whose bytes cannot be decoded, the system reports a
 *    read (bad-encoding) error that names the file.
 *
 * Error convention: CsvParser rejects its promise by throwing an
 * {@link IntakeFailure} that wraps a structured {@link IntakeError}. Tests use
 * `rejects` to capture the thrown value and the `isIntakeFailure` guard to read
 * the embedded `intakeError` (stage/kind/sourceFileName).
 *
 * This file is kept separate from `csv-parser.property.test.ts` (task 5.2) so
 * the two property suites can execute in parallel without file conflicts.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvParser } from "./csv-parser";
import { isIntakeFailure } from "./intake-failure";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/**
 * Construct a File from text content. jsdom (the Vitest environment here)
 * provides File/Blob and File.arrayBuffer(), which CsvParser uses via
 * TextDecoder, so no polyfill is required.
 */
function csvFileFromText(text: string, name: string): File {
  return new File([text], name, { type: "text/csv" });
}

/** Construct a File directly from raw bytes (to inject invalid UTF-8). */
function csvFileFromBytes(bytes: Uint8Array, name: string): File {
  // Pass a fresh ArrayBuffer-backed view as the BlobPart so the File carries
  // the exact bytes regardless of the source Uint8Array's backing buffer type.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new File([copy.buffer], name, { type: "text/csv" });
}

/**
 * A file name token (used to confirm the error names the specific file). We draw
 * from a safe charset and always append the `.csv` extension so the name reads
 * like a real CSV file; the parser carries `file.name` through verbatim.
 */
const fileNameArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ .".split(
        ""
      )
    ),
    minLength: 1,
    maxLength: 16,
  })
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => `${s}.csv`);

/**
 * CSV content with ZERO data rows. CsvParser uses `skipEmptyLines: "greedy"`, so
 * any of these forms yields no data rows and must be reported as `empty-file`:
 *  - completely empty content;
 *  - whitespace-only / blank lines only (greedy skip drops them all);
 *  - a single header line with no following data rows.
 */
const emptyCsvArb: fc.Arbitrary<string> = fc.oneof(
  // Completely empty content.
  fc.constant(""),
  // Only blank/whitespace lines (greedy skip removes them → zero rows).
  fc
    .array(fc.constantFrom("", " ", "   ", "\t"), { minLength: 1, maxLength: 5 })
    .map((lines) => lines.join("\n")),
  // A single header row and no data rows (header name tokens avoid the
  // delimiter/quote/newline chars so they stay a single clean header line).
  fc
    .array(
      fc
        .string({
          unit: fc.constantFrom(
            ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(
              ""
            )
          ),
          minLength: 1,
          maxLength: 8,
        })
        .filter((s) => s.length > 0),
      { minLength: 1, maxLength: 5 }
    )
    .map((header) => header.join(","))
);

/**
 * A byte sequence that is INVALID UTF-8. We build candidates from bytes that a
 * fatal-mode decoder rejects — lone continuation bytes (0x80–0xBF), 0xFE/0xFF
 * (never valid in UTF-8), and truncated multi-byte lead bytes (e.g. 0xC0/0xE0
 * followed by a non-continuation byte) — then FILTER to keep only those that a
 * `TextDecoder("utf-8", { fatal: true })` genuinely refuses to decode. This
 * mirrors the decode the parser performs, so a kept sample is guaranteed to
 * drive the `bad-encoding` path.
 */
const invalidUtf8BytesArb: fc.Arbitrary<Uint8Array> = fc
  .array(
    fc.oneof(
      // Lone continuation bytes — invalid unless preceded by a lead byte.
      fc.integer({ min: 0x80, max: 0xbf }),
      // 0xFE / 0xFF — never valid anywhere in UTF-8.
      fc.constantFrom(0xfe, 0xff),
      // Lead bytes for 2-/3-/4-byte sequences (left truncated below).
      fc.constantFrom(0xc0, 0xc1, 0xe0, 0xf0, 0xf5),
      // Some plain ASCII to mix valid and invalid bytes.
      fc.integer({ min: 0x41, max: 0x5a })
    ),
    { minLength: 1, maxLength: 16 }
  )
  .map((nums) => Uint8Array.from(nums))
  .filter((bytes) => !canDecodeUtf8(bytes));

/** True iff the bytes decode cleanly as UTF-8 under fatal error handling. */
function canDecodeUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

describe("CsvParser — Property 3: Empty file detection (CSV portion)", () => {
  const parser = new CsvParser();

  it("reports an empty-file error naming the file for any CSV with zero data rows", async () => {
    await fc.assert(
      fc.asyncProperty(
        emptyCsvArb,
        fileNameArb,
        async (content, fileName) => {
          const thrown = await parser
            .parse(csvFileFromText(content, fileName))
            .then(
              () => {
                throw new Error("expected parse to reject, but it resolved");
              },
              (err: unknown) => err
            );

          // The rejection must be a structured IntakeFailure.
          expect(isIntakeFailure(thrown)).toBe(true);
          if (!isIntakeFailure(thrown)) return;

          const { intakeError } = thrown;
          // empty-file at the parsing stage (Req 3.2).
          expect(intakeError.kind).toBe("empty-file");
          expect(intakeError.stage).toBe("parsing");
          // The error names the specific file.
          expect(intakeError.sourceFileName).toBe(fileName);
          expect(intakeError.message).toContain(fileName);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

describe("CsvParser — Property 4: Unreadable file detection (CSV portion)", () => {
  const parser = new CsvParser();

  it("reports a bad-encoding error naming the file for any CSV whose bytes cannot be decoded", async () => {
    await fc.assert(
      fc.asyncProperty(
        invalidUtf8BytesArb,
        fileNameArb,
        async (bytes, fileName) => {
          const thrown = await parser
            .parse(csvFileFromBytes(bytes, fileName))
            .then(
              () => {
                throw new Error("expected parse to reject, but it resolved");
              },
              (err: unknown) => err
            );

          // The rejection must be a structured IntakeFailure.
          expect(isIntakeFailure(thrown)).toBe(true);
          if (!isIntakeFailure(thrown)) return;

          const { intakeError } = thrown;
          // bad-encoding at the parsing stage (Req 3.3).
          expect(intakeError.kind).toBe("bad-encoding");
          expect(intakeError.stage).toBe("parsing");
          // The error names the specific file.
          expect(intakeError.sourceFileName).toBe(fileName);
          expect(intakeError.message).toContain(fileName);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
