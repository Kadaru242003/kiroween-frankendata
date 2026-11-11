/**
 * Name sanitization for the FrankenData file-intake pipeline.
 *
 * `createNameSanitizer` returns an implementation of the {@link NameSanitizer}
 * interface. Both methods are pure: given the same inputs they always produce
 * the same outputs and perform no I/O.
 *
 * - {@link NameSanitizer.sanitizeTableName} derives a valid, unique DuckDB table
 *   name from a source file name (Req 6.1–6.3).
 * - {@link NameSanitizer.sanitizeColumnNames} sanitizes a header row into valid,
 *   unique DuckDB column names (Req 6.4).
 *
 * Both table-name collision handling (against `existingNames`) and column-name
 * de-duplication use **case-insensitive** uniqueness: two names that differ only
 * in case are treated as the same name, with the first occurrence keeping its
 * casing and later occurrences receiving a numeric suffix.
 */

import type { NameSanitizer } from "./types";

/** Matches a run of one or more non-identifier characters. */
const NON_IDENTIFIER_RUN = /[^A-Za-z0-9_]+/g;
/** Matches a run of two or more underscores. */
const UNDERSCORE_RUN = /_{2,}/g;
/** Matches a leading digit. */
const LEADING_DIGIT = /^[0-9]/;

/**
 * Strip the directory and extension from a source file name, leaving the base
 * name only.
 *
 * `data/Sales 2024.csv` → `Sales 2024`. Directory segments are removed first
 * (handling both POSIX and Windows separators), then a single trailing
 * extension (`.csv`, `.xlsx`, …) is removed. A leading-dot-only name such as
 * `.csv` is treated as a dotfile with no extension and is returned unchanged
 * (minus any directory).
 */
function stripDirectoryAndExtension(sourceFileName: string): string {
  const base = sourceFileName.split(/[\\/]/).pop() ?? "";
  const lastDot = base.lastIndexOf(".");
  // Only strip when the dot is a real extension separator: not at the start
  // (dotfile) and not trailing (empty extension).
  if (lastDot > 0 && lastDot < base.length - 1) {
    return base.slice(0, lastDot);
  }
  return base;
}

/**
 * Apply the character-level sanitization shared by the table-name rules:
 * replace every run of non-identifier characters with a single underscore,
 * collapse consecutive underscores, and lowercase.
 */
function sanitizeIdentifierCore(input: string): string {
  return input
    .replace(NON_IDENTIFIER_RUN, "_")
    .replace(UNDERSCORE_RUN, "_")
    .toLowerCase();
}

/**
 * Derive the base DuckDB table name from a source file name, applying every
 * transformation except collision handling (Req 6.1, 6.2).
 *
 * Steps:
 * 1. Strip the directory and extension.
 * 2. Replace every non-`[A-Za-z0-9_]` character with `_`.
 * 3. Collapse consecutive underscores.
 * 4. Lowercase.
 * 5. If the result starts with a digit, prefix `t_`.
 *
 * The returned value may be an empty string when the source name has no
 * identifier characters; the caller resolves that (and any collision) with a
 * numeric suffix.
 */
function deriveBaseTableName(sourceFileName: string): string {
  const withoutExt = stripDirectoryAndExtension(sourceFileName);
  const core = sanitizeIdentifierCore(withoutExt);
  if (core.length > 0 && LEADING_DIGIT.test(core)) {
    return `t_${core}`;
  }
  return core;
}

/**
 * Resolve a candidate name to one not already present in `taken` (compared
 * case-insensitively), recording the result in `taken`.
 *
 * When `base` is non-empty and free, it is used as-is (the first occurrence of
 * a name keeps its original casing). Otherwise — the base is empty, or it
 * collides with a name already taken — a numeric suffix (`_2`, `_3`, …) is
 * appended to `seed` until a free name is found. For an empty base, `seed` is
 * the provided `fallback` (e.g. `table` or `column_3`) so the result is always
 * a valid identifier.
 */
function resolveUnique(
  base: string,
  taken: Set<string>,
  fallback: string
): string {
  const seed = base.length > 0 ? base : fallback;

  if (base.length > 0 && !taken.has(seed.toLowerCase())) {
    taken.add(seed.toLowerCase());
    return seed;
  }

  // Either the base was empty or it collided: append a numeric suffix starting
  // at _2 until we find a free name.
  let suffix = 2;
  for (;;) {
    const candidate = `${seed}_${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
    suffix += 1;
  }
}

/**
 * Create a stateless {@link NameSanitizer}. The returned object holds no
 * cross-call state; `existingNames` and the per-call header array fully
 * determine each result.
 */
export function createNameSanitizer(): NameSanitizer {
  return {
    sanitizeTableName(sourceFileName: string, existingNames: string[]): string {
      const taken = new Set(existingNames.map((n) => n.toLowerCase()));
      const base = deriveBaseTableName(sourceFileName);
      return resolveUnique(base, taken, "table");
    },

    sanitizeColumnNames(columnNames: string[]): string[] {
      const taken = new Set<string>();
      return columnNames.map((rawName, index) => {
        const trimmed = rawName.trim();
        // Blank/empty names become a position-based generated name (1-based).
        const base =
          trimmed.length === 0
            ? `column_${index + 1}`
            : sanitizeSpecialChars(rawName);
        return resolveUnique(base, taken, `column_${index + 1}`);
      });
    },
  };
}

/**
 * Sanitize a non-blank column name: replace every run of spaces and special
 * (non-`[A-Za-z0-9_]`) characters with a single underscore. Casing is
 * preserved so the first occurrence of a case-variant keeps its original form.
 *
 * If sanitization leaves an empty string (the name was all special
 * characters), an empty string is returned and the caller's fallback applies.
 */
function sanitizeSpecialChars(name: string): string {
  return name.replace(NON_IDENTIFIER_RUN, "_").replace(UNDERSCORE_RUN, "_");
}

/** A ready-to-use shared instance, since the sanitizer holds no state. */
export const nameSanitizer: NameSanitizer = createNameSanitizer();
