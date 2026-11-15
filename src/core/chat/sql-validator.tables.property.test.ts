/**
 * Property-based test for the SqlValidator's table allowlist and table-function
 * rule.
 *
 * Feature: frankendata-security-hardening, Property 1: any query that names a
 * non-allow-listed table or a blocked table function in a table position, at
 * any depth and in any FROM-list shape, is rejected, even when comments are
 * inserted between its tokens.
 *
 * The control direction builds the SAME shapes from allow-listed entries only
 * and asserts they are accepted, so a rejection above is caused by the bad
 * entry and not by the shape or the comments.
 *
 * Pure logic: no DuckDB, no network.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateSql } from "./sql-validator";

const TABLES = ["monsters", "experiments", "stitch_1_result"];

/** Allow-listed FROM-list entries in every shape the walk has to step over. */
const GOOD_ENTRIES = [
  "monsters",
  "experiments e",
  "monsters AS m(a, b)",
  "(SELECT 1) q",
  "(SELECT * FROM monsters) q",
  "monsters TABLESAMPLE 10%",
  "(monsters CROSS JOIN experiments) x",
  "main.monsters mm",
  "stitch_1_result",
];

/** Entries that must always be rejected. */
const BAD_ENTRIES = [
  "secret_table",
  "secret_table s",
  '"secret_table"',
  "main.secret_table",
  "(secret_table CROSS JOIN monsters) j",
  "(SELECT * FROM secret_table) z",
  "read_csv('x.csv')",
  "READ_CSV('x.csv')",
  '"read_csv"(\'x.csv\')',
  '"READ_CSV"(\'x.csv\')',
  "read_/**/csv('x.csv')",
  "read_parquet('x.parquet')",
  "parquet_scan('x.parquet')",
  "sniff_csv('x.csv')",
  "parquet_file_metadata('x.parquet')",
  "glob('*')",
  "query('x')",
  "query_table('monsters')",
  "range(5)",
  "generate_series(1, 5)",
  "(range(5))",
];

/** Wrappers that put the FROM list at a different depth. */
const WRAPPERS: ReadonlyArray<(list: string) => string> = [
  (l) => `SELECT * FROM ${l}`,
  (l) => `SELECT * FROM (SELECT * FROM ${l}) w`,
  (l) => `WITH a AS (SELECT * FROM ${l}) SELECT * FROM a`,
  (l) => `SELECT * FROM monsters WHERE id IN (SELECT id FROM ${l})`,
  (l) => `SELECT count(*) FROM ${l} GROUP BY 1`,
];

/** Separators that may replace a single space between tokens. */
const SEPS = [" ", "/**/", " /* c */ ", "\n", "-- c\n", "/* a */"];

const arbSeps = fc.array(fc.constantFrom(...SEPS), { minLength: 60, maxLength: 60 });

/** Replace each single space with a (possibly comment) separator. */
function withSeparators(sql: string, seps: string[]): string {
  const parts = sql.split(" ");
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out += seps[(i - 1) % seps.length] + parts[i];
  }
  return out;
}

const arbGoodList = fc.array(fc.constantFrom(...GOOD_ENTRIES), { minLength: 0, maxLength: 3 });
const arbWrapper = fc.constantFrom(...WRAPPERS);
const arbJoiner = fc.constantFrom(", ", " CROSS JOIN ", " JOIN ");

function build(entries: string[], wrap: (l: string) => string, joiner: string, seps: string[]): string {
  // JOIN needs an ON clause; use a comma list for the comma joiner and
  // CROSS JOIN for the others so every generated query is syntactically sane.
  const list = entries.join(joiner === " JOIN " ? " CROSS JOIN " : joiner);
  return withSeparators(wrap(list), seps);
}

describe("Feature: frankendata-security-hardening, Property 1: table allowlist and table-function rule", () => {
  it("rejects a bad entry at any position, depth and with comments between tokens", () => {
    fc.assert(
      fc.property(
        arbGoodList,
        fc.constantFrom(...BAD_ENTRIES),
        fc.nat(),
        arbWrapper,
        arbJoiner,
        arbSeps,
        (good, bad, at, wrap, joiner, seps) => {
          const entries = [...good];
          entries.splice(at % (entries.length + 1), 0, bad);
          const sql = build(entries, wrap, joiner, seps);
          const r = validateSql(sql, TABLES);
          expect(r.ok, sql).toBe(false);
        }
      ),
      { numRuns: 400 }
    );
  });

  it("control: the same shapes with only allow-listed entries are accepted", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...GOOD_ENTRIES), { minLength: 1, maxLength: 3 }),
        arbWrapper,
        arbJoiner,
        arbSeps,
        (good, wrap, joiner, seps) => {
          const sql = build(good, wrap, joiner, seps);
          const r = validateSql(sql, TABLES);
          expect(r.ok, sql).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("accepted output never contains a blocked function name that the input split with a comment", () => {
    fc.assert(
      fc.property(arbSeps, (seps) => {
        const sql = withSeparators("SELECT * FROM (SELECT 1) q, read_/**/csv('x.csv')", seps);
        const r = validateSql(sql, TABLES);
        if (r.ok) expect(r.sql).not.toMatch(/read_csv|read_parquet|sniff_csv/i);
      })
    );
  });
});
