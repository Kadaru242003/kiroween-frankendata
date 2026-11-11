/**
 * Property-based test for the SqlValidator's core safety invariant.
 *
 * Feature: frankendata-chat-sql, Property 1: Validator rejects forbidden
 * keywords and second statements.
 *
 * Validates: Requirements 5.2, 5.3, 5.4, 10.5
 *
 * Property 1 statement: for any SQL that embeds a forbidden keyword as a WHOLE
 * WORD outside string literals and quoted identifiers, OR embeds a second
 * `;`-separated statement, `validateSql` returns `ok: false`. The generator
 * deliberately builds both bare forbidden keywords (which MUST reject) and the
 * same keywords inside `'…'` / `"…"` (which are harmless data); the property
 * asserts the bare/second-statement cases reject.
 *
 * This is a pure-logic property: no DuckDB, no network.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateSql } from "./sql-validator";

const TABLES = ["monsters", "experiments", "stitch_1_result"];
const FORBIDDEN = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "ATTACH",
  "DETACH",
  "COPY",
  "PRAGMA",
  "INSTALL",
  "LOAD",
  "CALL",
  "EXPORT",
  "SET",
];

/** Randomly upper/lower-case a keyword so the whole-word match is case-insensitive. */
function mixCase(word: string, seed: number): string {
  return word
    .split("")
    .map((ch, i) => ((seed >> i) & 1 ? ch.toUpperCase() : ch.toLowerCase()))
    .join("");
}

describe("Property 1 — validator rejects forbidden keywords / second statements (Req 5.2–5.4, 10.5)", () => {
  it("rejects a bare forbidden keyword anywhere in the statement", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN),
        fc.integer({ min: 0, max: 0x7fff }),
        fc.constantFrom(...TABLES),
        (kw, seed, table) => {
          // Embed the forbidden keyword as a standalone word after a valid head.
          const sql = `SELECT * FROM ${table} WHERE ${mixCase(kw, seed)} AND x = 1`;
          const r = validateSql(sql, TABLES);
          expect(r.ok).toBe(false);
        }
      )
    );
  });

  it("rejects a second `;`-separated statement", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TABLES),
        fc.constantFrom(...TABLES),
        (t1, t2) => {
          const sql = `SELECT * FROM ${t1}; SELECT * FROM ${t2}`;
          const r = validateSql(sql, TABLES);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.reason).toBe("multiple-statements");
        }
      )
    );
  });

  it("a forbidden keyword inside a string literal or quoted identifier does NOT, by itself, force rejection", () => {
    // Control direction: the SAME keyword, but as data. This query is otherwise
    // valid, so it must be ACCEPTED — proving the reject in the bare case is due
    // to the keyword being a real token, not a substring scan.
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN),
        fc.constantFrom(...TABLES),
        (kw, table) => {
          const asLiteral = `SELECT * FROM ${table} WHERE status = '${kw}'`;
          const asIdent = `SELECT "${kw.toLowerCase()}" FROM ${table}`;
          expect(validateSql(asLiteral, TABLES).ok).toBe(true);
          expect(validateSql(asIdent, TABLES).ok).toBe(true);
        }
      )
    );
  });
});
