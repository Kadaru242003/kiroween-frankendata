/**
 * Property-based tests for table name derivation and sanitization.
 *
 * Feature: frankendata-file-intake, Property 21: Table name derivation and sanitization
 *
 * Validates: Requirements 6.1, 6.2
 *
 * Property 21 statement: For any source file name, the derived DuckDB table
 * name is a valid identifier with spaces/symbols replaced by underscores, no
 * leading digit, and no file extension.
 *
 * The function under test is {@link NameSanitizer.sanitizeTableName} via the
 * `nameSanitizer` singleton. To isolate derivation/sanitization from the
 * collision-handling path (covered separately by Property 22), every call here
 * passes an empty `existingNames` array so no numeric collision suffix is
 * appended.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { nameSanitizer } from "./name-sanitizer";

const NUM_RUNS = 200;

/** A valid DuckDB identifier: word chars only, not starting with a digit. */
const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Arbitrary file name generator. We intentionally generate broadly so the
 * invariants are exercised against the messy real-world inputs Property 21
 * cares about:
 * - arbitrary base names (spaces, symbols, leading digits, unicode);
 * - optional directory segments (POSIX or Windows separators);
 * - optional file extensions.
 *
 * `fc.string({ unit: "binary" })` draws from a wide character range including
 * dots, slashes, backslashes, spaces, symbols, and control characters, so even
 * the "simple" base covers pathological cases (all-symbol names, names that
 * reduce to empty after stripping). We also mix in a hand-picked set of
 * identifier-hostile characters to guarantee they appear frequently.
 */
const messyChars = fc.constantFrom(
  " ",
  ".",
  "/",
  "\\",
  "-",
  "@",
  "#",
  "$",
  "%",
  "&",
  "(",
  ")",
  "!",
  "_",
  "0",
  "9",
  "é",
  "空"
);

const baseSegment = fc.oneof(
  fc.string({ unit: "binary", minLength: 0, maxLength: 30 }),
  fc.stringMatching(/^[0-9A-Za-z _.\-@#$%&()]{0,30}$/),
  fc.array(messyChars, { minLength: 0, maxLength: 30 }).map((cs) => cs.join(""))
);

const extension = fc.option(
  fc.constantFrom("csv", "xlsx", "CSV", "XLSX", "txt", "data.csv", "tar.gz"),
  { nil: undefined }
);

const directory = fc.option(
  fc
    .array(fc.string({ unit: "binary", minLength: 1, maxLength: 10 }), {
      minLength: 1,
      maxLength: 3,
    })
    .map((parts) => parts.join("/")),
  { nil: undefined }
);

const fileName = fc
  .tuple(directory, baseSegment, extension)
  .map(([dir, base, ext]) => {
    let name = base;
    if (ext !== undefined) {
      name = `${name}.${ext}`;
    }
    if (dir !== undefined) {
      name = `${dir}/${name}`;
    }
    return name;
  });

describe("Property 21: Table name derivation and sanitization", () => {
  it("produces a valid identifier (word chars only, no leading digit) for any source file name", () => {
    fc.assert(
      fc.property(fileName, (sourceFileName) => {
        const table = nameSanitizer.sanitizeTableName(sourceFileName, []);
        expect(table).toMatch(VALID_IDENTIFIER);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("is always non-empty", () => {
    fc.assert(
      fc.property(fileName, (sourceFileName) => {
        const table = nameSanitizer.sanitizeTableName(sourceFileName, []);
        expect(table.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("is lowercase", () => {
    fc.assert(
      fc.property(fileName, (sourceFileName) => {
        const table = nameSanitizer.sanitizeTableName(sourceFileName, []);
        expect(table).toBe(table.toLowerCase());
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("collapses consecutive underscores (no run of two or more)", () => {
    fc.assert(
      fc.property(fileName, (sourceFileName) => {
        const table = nameSanitizer.sanitizeTableName(sourceFileName, []);
        expect(table).not.toMatch(/__/);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("contains no path separators and no extension dot", () => {
    fc.assert(
      fc.property(fileName, (sourceFileName) => {
        const table = nameSanitizer.sanitizeTableName(sourceFileName, []);
        expect(table).not.toContain(".");
        expect(table).not.toContain("/");
        expect(table).not.toContain("\\");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("holds all invariants simultaneously for names with spaces, symbols, leading digits, extensions, and directories", () => {
    fc.assert(
      fc.property(fileName, (sourceFileName) => {
        const table = nameSanitizer.sanitizeTableName(sourceFileName, []);
        expect(table).toMatch(VALID_IDENTIFIER);
        expect(table).toBe(table.toLowerCase());
        expect(table.length).toBeGreaterThan(0);
        expect(table).not.toMatch(/__/);
        expect(table).not.toContain(".");
        expect(table).not.toContain("/");
        expect(table).not.toContain("\\");
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
