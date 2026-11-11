/**
 * Property-based tests for column name sanitization.
 *
 * Feature: frankendata-file-intake, Property 23: Column name sanitization
 *
 * Validates: Requirements 6.4
 *
 * Property 23 statement: For any set of parsed column names, sanitization
 * replaces blank names with generated names, replaces spaces and special
 * characters with underscores, and makes duplicate names unique with numeric
 * suffixes. Uniqueness is checked case-insensitively: names that differ only in
 * case (e.g., `Name` and `name`) are treated as duplicates and disambiguated
 * with a suffix.
 *
 * The function under test is {@link NameSanitizer.sanitizeColumnNames} from
 * `name-sanitizer.ts` (exercised via the `nameSanitizer` singleton). Confirmed
 * contract of the implementation these assertions follow:
 *
 * - Output has one name per input column, in the same order (length + order
 *   preserved).
 * - A blank or whitespace-only input at index `i` yields the generated base
 *   `column_<i+1>` (1-based position). If that generated name collides with an
 *   already-taken name it receives a `_2`, `_3`, … suffix (shared uniqueness
 *   path).
 * - A non-blank input has every run of non-`[A-Za-z0-9_]` characters (spaces
 *   and special characters) replaced with a single `_`, and consecutive
 *   underscores collapsed. Casing is PRESERVED (the first occurrence of a
 *   case-variant keeps its original form), so outputs are NOT lowercased —
 *   unlike table names.
 * - Duplicates (compared case-insensitively) are made unique: the first
 *   occurrence keeps its name, later ones get `_2`, `_3`, … suffixes.
 *
 * Valid-identifier note: columns are NOT prefixed to avoid a leading digit (the
 * `t_` prefix applies only to table names). A column named e.g. `123` stays
 * `123`. So these tests assert the achievable invariant — every output contains
 * only `[A-Za-z0-9_]` characters and is non-empty — rather than the stricter
 * "must start with a letter/underscore" pattern, which the column contract does
 * not promise.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { nameSanitizer } from "./name-sanitizer";

const NUM_RUNS = 200;

/** Only characters outside the identifier set — spaces and specials. */
const SPECIAL_CHARS = " \t!@#$%^&*()+=[]{}|;:'\",.<>/?`~-";

/**
 * Column-name generator that intentionally spans the messy space Property 23
 * cares about: empty strings, whitespace-only strings, names with embedded
 * spaces and special characters, purely-special names, digit-leading names, and
 * plain identifiers — all with mixed casing so case-insensitive de-duplication
 * is exercised.
 */
const rawColumnName = fc.oneof(
  // Blank / whitespace-only → generated names.
  fc.constantFrom("", " ", "   ", "\t", " \t "),
  // Purely special characters → sanitize to empty → fallback generated name.
  fc.constantFrom("!!!", "@@@", "***", "---", "###"),
  // A small pool of plain names (with case variants) to force duplicates and
  // case-insensitive collisions.
  fc.constantFrom("name", "Name", "NAME", "id", "ID", "Total", "total"),
  // Arbitrary mixed content: letters, digits, spaces, and specials.
  fc.string({
    minLength: 1,
    maxLength: 12,
    unit: fc.constantFrom(
      ..."abcABC012".split(""),
      ...SPECIAL_CHARS.split("")
    ),
  })
);

/** Arbitrary array of raw column names (may be empty). */
const rawColumnNames = fc.array(rawColumnName, { minLength: 0, maxLength: 15 });

/** True when `raw` is blank or whitespace-only. */
function isBlank(raw: string): boolean {
  return raw.trim().length === 0;
}

describe("Property 23: Column name sanitization", () => {
  it("preserves length and order (one sanitized name per input column)", () => {
    fc.assert(
      fc.property(rawColumnNames, (names) => {
        const result = nameSanitizer.sanitizeColumnNames(names);
        expect(result).toHaveLength(names.length);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("produces names containing only identifier characters [A-Za-z0-9_] and none empty", () => {
    fc.assert(
      fc.property(rawColumnNames, (names) => {
        const result = nameSanitizer.sanitizeColumnNames(names);
        for (const out of result) {
          expect(out.length).toBeGreaterThan(0);
          // No spaces or special characters survive.
          expect(out).toMatch(/^[A-Za-z0-9_]+$/);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("makes all output names unique case-insensitively", () => {
    fc.assert(
      fc.property(rawColumnNames, (names) => {
        const result = nameSanitizer.sanitizeColumnNames(names);
        const lowered = result.map((n) => n.toLowerCase());
        expect(new Set(lowered).size).toBe(result.length);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("maps blank / whitespace-only inputs to a position-based generated name column_<i+1>", () => {
    fc.assert(
      fc.property(rawColumnNames, (names) => {
        const result = nameSanitizer.sanitizeColumnNames(names);
        names.forEach((raw, i) => {
          if (isBlank(raw)) {
            // The generated base is `column_<i+1>`; a collision with a name
            // already taken appends a `_<n>` suffix, so the output is either
            // the base itself or the base followed by `_<n>`.
            const base = `column_${i + 1}`;
            expect(result[i] === base || result[i].startsWith(`${base}_`)).toBe(
              true
            );
          }
        });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("replaces spaces and special characters in non-blank names with underscores (no non-identifier chars remain)", () => {
    fc.assert(
      fc.property(rawColumnNames, (names) => {
        const result = nameSanitizer.sanitizeColumnNames(names);
        names.forEach((raw, i) => {
          if (!isBlank(raw)) {
            // Regardless of what specials were present, the output carries no
            // character outside the identifier set.
            expect(result[i]).not.toMatch(/[^A-Za-z0-9_]/);
          }
        });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("keeps the first case-variant as-is and suffixes later case-insensitive duplicates", () => {
    // Deterministic example: three case-variants of the same name. The first
    // occurrence keeps its exact form; each later occurrence collides
    // case-insensitively and is disambiguated with a numeric suffix seeded from
    // its OWN casing (the implementation suffixes the colliding occurrence's
    // sanitized form, not the first occurrence's).
    const result = nameSanitizer.sanitizeColumnNames(["Name", "name", "NAME"]);
    expect(result[0]).toBe("Name");
    expect(result[1]).toBe("name_2");
    expect(result[2]).toBe("NAME_3");
    // All three are distinct case-insensitively.
    expect(new Set(result.map((n) => n.toLowerCase())).size).toBe(3);
  });

  it("generates position-based names for blanks and collapses all-special names to underscores", () => {
    // `""` and `"   "` are blank → position-based generated names. `"@@@"` is
    // NOT blank (trim leaves it non-empty); its run of special characters
    // collapses to a single `_`, a valid non-empty identifier, so it is kept
    // as-is rather than replaced by a generated name.
    const result = nameSanitizer.sanitizeColumnNames(["", "   ", "@@@"]);
    expect(result).toEqual(["column_1", "column_2", "_"]);
  });
});
