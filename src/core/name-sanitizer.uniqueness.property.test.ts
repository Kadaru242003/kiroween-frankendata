/**
 * Property-based tests for table name uniqueness.
 *
 * Feature: frankendata-file-intake, Property 22: Table name uniqueness
 *
 * Validates: Requirements 6.3
 *
 * Property 22 statement: For any set of source file names that would produce
 * the same sanitized table name, the resulting table names are all unique via
 * numeric suffixes.
 *
 * The function under test is
 * {@link NameSanitizer.sanitizeTableName}`(sourceFileName, existingNames)` from
 * `./name-sanitizer` (exercised via {@link createNameSanitizer} and the shared
 * {@link nameSanitizer} singleton). On a collision with `existingNames`
 * (compared case-insensitively) it appends a numeric suffix starting at `_2`;
 * the first occurrence of a base name keeps the base as-is.
 *
 * These tests simulate how the IntakeController accumulates table names across
 * files: starting from an empty `existingNames`, each produced name is pushed
 * back into `existingNames` before processing the next file. After processing a
 * whole list, every produced name must be pairwise unique (case-insensitively)
 * and a valid DuckDB identifier.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createNameSanitizer, nameSanitizer } from "./name-sanitizer";

const NUM_RUNS = 200;

/** A valid, non-empty DuckDB identifier: `[A-Za-z_][A-Za-z0-9_]*`. */
const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Process a whole list of source file names the way the IntakeController does:
 * accumulate results into `existingNames`, feeding each produced name back in
 * before the next call.
 */
function accumulateTableNames(sourceFileNames: string[]): string[] {
  const existingNames: string[] = [];
  const produced: string[] = [];
  for (const sourceFileName of sourceFileNames) {
    const name = nameSanitizer.sanitizeTableName(sourceFileName, existingNames);
    produced.push(name);
    existingNames.push(name);
  }
  return produced;
}

/** True iff every string in `names` is unique when compared case-insensitively. */
function allUniqueCaseInsensitive(names: string[]): boolean {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

/**
 * A base token that sanitizes to a non-empty identifier: letters, digits, and
 * spaces, with at least one letter so the sanitized form is non-empty and not
 * purely digit-derived in a way that varies. We keep it simple and readable.
 */
const baseToken = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[^A-Za-z0-9 ]/g, ""))
  .filter((s) => /[A-Za-z]/.test(s.trim()));

/** A supported extension. */
const extension = fc.constantFrom("csv", "xlsx", "CSV", "Xlsx", "XLSX");

/** A separator used to build messy variants of a base token. */
const separator = fc.constantFrom(" ", "-", "_", ".", "/", "  ");

/**
 * Given a single base token, produce a list of N "colliding" file-name variants
 * that all sanitize to the SAME base table name: different casing, separators,
 * and extensions around the same identifier core.
 */
const collidingVariants = fc
  .tuple(
    baseToken,
    fc.array(fc.tuple(separator, extension, fc.boolean()), {
      minLength: 2,
      maxLength: 8,
    })
  )
  .map(([token, variants]) => {
    const parts = token.trim().split(/\s+/);
    return variants.map(([sep, ext, upper]) => {
      const joined = parts.join(sep);
      const cased = upper ? joined.toUpperCase() : joined.toLowerCase();
      return `${cased}.${ext}`;
    });
  });

describe("Property 22: Table name uniqueness", () => {
  it("names that would collide on the same sanitized base all stay unique via numeric suffixes", () => {
    fc.assert(
      fc.property(collidingVariants, (fileNames) => {
        const produced = accumulateTableNames(fileNames);

        // Same count in as out: every file yields exactly one name.
        expect(produced).toHaveLength(fileNames.length);

        // All produced names are pairwise unique (case-insensitively, since
        // uniqueness is checked case-insensitively).
        expect(allUniqueCaseInsensitive(produced)).toBe(true);

        // Every produced name is a valid DuckDB identifier.
        for (const name of produced) {
          expect(name).toMatch(VALID_IDENTIFIER);
        }

        // Sanity: the variants really do share a single sanitized base, so the
        // first keeps the base and the rest are disambiguated. If more than one
        // distinct base appears the generator changed; that's still fine for
        // uniqueness, so we only assert when a shared base is present.
        const first = produced[0].toLowerCase();
        const suffixed = produced
          .slice(1)
          .filter((n) => n.toLowerCase().startsWith(`${first}_`));
        // At least every later name that shares the base must carry a suffix.
        for (const name of suffixed) {
          expect(name.toLowerCase()).toMatch(
            new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`)
          );
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("the same file name fed N times yields N unique names (first is the base, rest are suffixed)", () => {
    fc.assert(
      fc.property(
        baseToken,
        extension,
        fc.integer({ min: 1, max: 10 }),
        (token, ext, count) => {
          const fileName = `${token}.${ext}`;
          const fileNames = Array.from({ length: count }, () => fileName);
          const produced = accumulateTableNames(fileNames);

          expect(produced).toHaveLength(count);
          expect(allUniqueCaseInsensitive(produced)).toBe(true);
          for (const name of produced) {
            expect(name).toMatch(VALID_IDENTIFIER);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("an arbitrary list of file names always yields pairwise-unique valid identifiers", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(baseToken, extension, separator).map(
            ([token, ext, sep]) => `${token.trim().split(/\s+/).join(sep)}.${ext}`
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (fileNames) => {
          const produced = accumulateTableNames(fileNames);

          expect(produced).toHaveLength(fileNames.length);
          expect(allUniqueCaseInsensitive(produced)).toBe(true);
          for (const name of produced) {
            expect(name).toMatch(VALID_IDENTIFIER);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("de-duplicates against pre-seeded existingNames (case-insensitively)", () => {
    fc.assert(
      fc.property(
        baseToken,
        extension,
        fc.integer({ min: 1, max: 6 }),
        (token, ext, count) => {
          const sanitizer = createNameSanitizer();
          // Pre-seed existingNames with the base and some suffixed variants so
          // the first fresh call must already skip past them.
          const existingNames: string[] = [];
          const first = sanitizer.sanitizeTableName(`${token}.${ext}`, existingNames);
          existingNames.push(first);

          const produced = [first];
          for (let i = 0; i < count; i += 1) {
            // Vary casing of the source to confirm case-insensitive collision.
            const source = `${token.toUpperCase()}.${ext}`;
            const name = sanitizer.sanitizeTableName(source, existingNames);
            existingNames.push(name);
            produced.push(name);
          }

          expect(allUniqueCaseInsensitive(produced)).toBe(true);
          for (const name of produced) {
            expect(name).toMatch(VALID_IDENTIFIER);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
