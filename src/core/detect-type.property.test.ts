/**
 * Property-based tests for file type routing from extension.
 *
 * Feature: frankendata-file-intake, Property 6: File type routing from extension
 *
 * Validates: Requirements 2.1, 2.2
 *
 * Property 6 statement: For any dropped file, the detected type and selected
 * parser are determined solely by the file extension: `.csv` selects the CSV
 * (PapaParse) parser, `.xlsx` selects the XLSX (SheetJS) parser, and any other
 * extension is marked unsupported with an error naming the file.
 *
 * The function under test is {@link detectType}, the extension-only routing
 * layer. `detectType` returns a `FileType` (`csv` | `xlsx` | `unsupported`);
 * the "error naming the file" part of Property 6 is produced downstream by the
 * IntakeController (covered at the controller level, task 12.x). These tests
 * focus on the extension → FileType routing that `detectType` provides.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { detectType } from "./detect-type";
import type { FileType } from "./types";

const NUM_RUNS = 200;

/**
 * Base-name generator: non-empty strings that do NOT contain a dot, a slash, or
 * a backslash. Excluding dots guarantees the extension we append is the only
 * extension in the name; excluding path separators keeps the base name from
 * being interpreted as a directory segment.
 *
 * The base name must be non-empty: `detectType` treats a leading-dot-only name
 * (e.g. `.csv`, which is what an empty base produces) as a dotfile with no
 * extension → `unsupported` (a documented edge case of the routing layer). A
 * genuine `name.ext` requires at least one character before the dot, so we
 * require `minLength: 1` here.
 */
const baseName = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => !/[.\\/]/.test(s));

/**
 * Randomly re-case a string, letter by letter, so we exercise case-insensitive
 * extension matching (e.g. `CSV`, `Csv`, `cSv`).
 */
function withCasing(value: string, flags: boolean[]): string {
  return value
    .split("")
    .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
    .join("");
}

/** Arbitrary that yields a supported extension with arbitrary casing. */
const supportedExtWithCasing = fc
  .tuple(
    fc.constantFrom("csv", "xlsx"),
    fc.array(fc.boolean(), { minLength: 4, maxLength: 4 })
  )
  .map(([ext, flags]) => ({ ext, cased: withCasing(ext, flags) }));

/**
 * Arbitrary "other" extension: any non-empty alphanumeric string that is NOT
 * `csv` or `xlsx` (compared case-insensitively). These must all route to
 * `unsupported`.
 */
const otherExt = fc
  .string({ minLength: 1, maxLength: 6 })
  .filter((s) => /^[A-Za-z0-9]+$/.test(s))
  .filter((s) => {
    const lower = s.toLowerCase();
    return lower !== "csv" && lower !== "xlsx";
  });

describe("Property 6: File type routing from extension", () => {
  it("routes .csv / .xlsx to the matching FileType regardless of case", () => {
    fc.assert(
      fc.property(baseName, supportedExtWithCasing, (base, { ext, cased }) => {
        const fileName = `${base}.${cased}`;
        const expected: FileType = ext === "csv" ? "csv" : "xlsx";
        expect(detectType(fileName)).toBe(expected);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("marks any other extension as unsupported", () => {
    fc.assert(
      fc.property(baseName, otherExt, (base, ext) => {
        const fileName = `${base}.${ext}`;
        expect(detectType(fileName)).toBe<FileType>("unsupported");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("depends only on the extension: same extension yields the same type across different base names", () => {
    fc.assert(
      fc.property(
        baseName,
        baseName,
        fc.oneof(
          supportedExtWithCasing.map(({ cased }) => cased),
          otherExt
        ),
        (baseA, baseB, ext) => {
          const typeA = detectType(`${baseA}.${ext}`);
          const typeB = detectType(`${baseB}.${ext}`);
          expect(typeA).toBe(typeB);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("depends only on the extension: a leading directory path does not change the result", () => {
    fc.assert(
      fc.property(
        baseName,
        baseName,
        fc.oneof(
          supportedExtWithCasing.map(({ cased }) => cased),
          otherExt
        ),
        (dir, base, ext) => {
          const plain = detectType(`${base}.${ext}`);
          const withDir = detectType(`${dir}/${base}.${ext}`);
          expect(withDir).toBe(plain);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
