/**
 * Property-based test for the SqlValidator's LIMIT guarantee.
 *
 * Feature: frankendata-chat-sql, Property 2: Accepted SQL always carries a
 * LIMIT.
 *
 * Validates: Requirements 5.7, 10.5
 *
 * Property 2 statement: for any SQL that `validateSql` accepts, the returned
 * SQL contains a `LIMIT` — either the one the query already had, or the
 * appended `ASK_DEFAULT_SQL_LIMIT`. The generator builds a variety of valid
 * SELECT/WITH queries over the known tables, some already carrying a LIMIT and
 * some not.
 *
 * This is a pure-logic property: no DuckDB, no network.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateSql } from "./sql-validator";
import { ASK_DEFAULT_SQL_LIMIT } from "./types";

const TABLES = ["monsters", "experiments", "stitch_1_result"];

/** Build an assortment of valid SELECT/WITH queries over the known tables. */
function validQueryArb(): fc.Arbitrary<string> {
  const table = fc.constantFrom(...TABLES);
  const col = fc.constantFrom("*", "id", "name", "count(*)", "species");
  const existingLimit = fc.integer({ min: 1, max: 999999 });

  const plain = fc.tuple(col, table).map(([c, t]) => `SELECT ${c} FROM ${t}`);
  const withLimit = fc
    .tuple(col, table, existingLimit)
    .map(([c, t, n]) => `SELECT ${c} FROM ${t} LIMIT ${n}`);
  const grouped = fc
    .tuple(table)
    .map(([t]) => `SELECT species, COUNT(*) FROM ${t} GROUP BY species`);
  const cte = fc
    .tuple(table)
    .map(([t]) => `WITH q AS (SELECT * FROM ${t}) SELECT * FROM q`);
  const joined = fc
    .tuple(fc.constantFrom(...TABLES), fc.constantFrom(...TABLES))
    .map(([a, b]) => `SELECT * FROM ${a} JOIN ${b} ON a.id = b.id`);

  return fc.oneof(plain, withLimit, grouped, cte, joined);
}

describe("Property 2 — accepted SQL always carries a LIMIT (Req 5.7, 10.5)", () => {
  it("every accepted query's output contains a LIMIT", () => {
    fc.assert(
      fc.property(validQueryArb(), (sql) => {
        const r = validateSql(sql, TABLES);
        // Not every generated string is guaranteed to be accepted, but when it
        // is, the output must carry a LIMIT.
        if (r.ok) {
          expect(/\blimit\b/i.test(r.sql)).toBe(true);
        }
      })
    );
  });

  it("appends ASK_DEFAULT_SQL_LIMIT when the query had none", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TABLES),
        fc.constantFrom("*", "id", "name"),
        (t, c) => {
          const r = validateSql(`SELECT ${c} FROM ${t}`, TABLES);
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.sql).toContain(`LIMIT ${ASK_DEFAULT_SQL_LIMIT}`);
        }
      )
    );
  });
});
