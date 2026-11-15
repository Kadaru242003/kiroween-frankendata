/**
 * Unit tests for the "Ask the Lab" SqlValidator (Feature 3, task 2).
 *
 * Covers the design "SqlValidator algorithm" and Requirements 5.2–5.7, 10.1:
 * accepted SELECT/WITH; forbidden keywords bare (reject) vs. inside a literal
 * or quoted identifier (accept); chained statements; file/network table
 * functions; string/quoted-path table positions; table-function in FROM;
 * comma-separated and dotted references; CTE aliases; unknown tables; and
 * LIMIT enforcement.
 */

import { describe, expect, it } from "vitest";
import { validateSql, tokenize } from "./sql-validator";
import { ASK_DEFAULT_SQL_LIMIT } from "./types";

const TABLES = ["monsters", "experiments", "stitch_1_result"];

function accept(sql: string, tables: string[] = TABLES) {
  const r = validateSql(sql, tables);
  if (!r.ok) throw new Error(`expected accept, got reject: ${r.reason} for: ${sql}`);
  return r.sql;
}

function rejectReason(sql: string, tables: string[] = TABLES) {
  const r = validateSql(sql, tables);
  expect(r.ok).toBe(false);
  return r.ok ? null : r.reason;
}

describe("tokenize", () => {
  it("separates words, string literals, and quoted identifiers", () => {
    const toks = tokenize(`SELECT "set" FROM t WHERE x = 'Load'`);
    const words = toks.filter((t) => t.kind === "word").map((t) => t.text.toUpperCase());
    expect(words).toContain("SELECT");
    expect(words).toContain("FROM");
    expect(words).not.toContain("SET"); // "set" is a quoted identifier
    expect(words).not.toContain("LOAD"); // 'Load' is a string literal
    expect(toks.some((t) => t.kind === "ident" && t.text === "set")).toBe(true);
    expect(toks.some((t) => t.kind === "string" && t.text === "Load")).toBe(true);
  });

  it("strips line and block comments", () => {
    const toks = tokenize("SELECT 1 -- DROP TABLE t\n/* DELETE */ FROM t");
    const words = toks.filter((t) => t.kind === "word").map((t) => t.text.toUpperCase());
    expect(words).not.toContain("DROP");
    expect(words).not.toContain("DELETE");
    expect(words).toContain("SELECT");
    expect(words).toContain("FROM");
  });

  it("handles '' and \"\" escapes", () => {
    const toks = tokenize(`SELECT 'O''Brien', "a""b" FROM t`);
    expect(toks.some((t) => t.kind === "string" && t.text === "O'Brien")).toBe(true);
    expect(toks.some((t) => t.kind === "ident" && t.text === 'a"b')).toBe(true);
  });

  it("handles dollar-quoted strings", () => {
    const toks = tokenize("SELECT $$ DROP $$ FROM t");
    expect(toks.filter((t) => t.kind === "word").map((t) => t.text.toUpperCase())).not.toContain("DROP");
  });
});

describe("accepted queries", () => {
  it("accepts a simple SELECT and enforces a LIMIT", () => {
    expect(accept("SELECT * FROM monsters")).toBe(
      `SELECT * FROM monsters LIMIT ${ASK_DEFAULT_SQL_LIMIT}`
    );
  });

  it("accepts a WITH (CTE) query, alias allowed as a reference", () => {
    const sql =
      "WITH recent AS (SELECT * FROM experiments) SELECT * FROM recent";
    expect(accept(sql)).toContain(`LIMIT ${ASK_DEFAULT_SQL_LIMIT}`);
  });

  it("accepts multiple CTEs referencing each other and base tables", () => {
    const sql =
      "WITH a AS (SELECT * FROM monsters), b AS (SELECT * FROM a) SELECT * FROM b";
    expect(accept(sql)).toBeTruthy();
  });

  it("accepts a join of two queryable tables", () => {
    const sql =
      "SELECT * FROM monsters JOIN experiments ON monsters.id = experiments.id";
    expect(accept(sql)).toBeTruthy();
  });

  it("accepts a comma join of two queryable tables", () => {
    expect(accept("SELECT * FROM monsters, experiments")).toBeTruthy();
  });

  it("accepts aliased tables (AS and bare)", () => {
    expect(accept("SELECT m.x FROM monsters AS m")).toBeTruthy();
    expect(accept("SELECT m.x FROM monsters m")).toBeTruthy();
  });

  it("accepts main.<table> dotted references", () => {
    expect(accept("SELECT * FROM main.monsters")).toBeTruthy();
  });

  it("accepts a forbidden word inside a string literal", () => {
    expect(accept("SELECT * FROM monsters WHERE status = 'Load'")).toBeTruthy();
  });

  it("accepts a forbidden word as a quoted identifier (column named set)", () => {
    expect(accept('SELECT "set" FROM monsters')).toBeTruthy();
  });

  it("leaves an existing LIMIT unchanged", () => {
    const out = accept("SELECT * FROM monsters LIMIT 10");
    expect(out).toContain("LIMIT 10");
    expect(out).not.toContain(`LIMIT ${ASK_DEFAULT_SQL_LIMIT}`);
  });

  it("strips comments and a trailing semicolon from the accepted SQL", () => {
    const out = accept("SELECT * FROM monsters; -- trailing comment");
    expect(out).not.toContain(";");
    expect(out).not.toContain("--");
    expect(out).toContain(`LIMIT ${ASK_DEFAULT_SQL_LIMIT}`);
  });
});

describe("rejected: read-only single statement", () => {
  it("rejects an empty / comment-only statement", () => {
    expect(rejectReason("-- just a comment")).toBe("empty");
  });

  it("rejects a non-SELECT/WITH first keyword", () => {
    // The first-keyword check runs before the forbidden-keyword scan, so a
    // statement that merely starts with the wrong keyword is "not-select".
    expect(rejectReason("EXPLAIN SELECT * FROM monsters")).toBe("not-select");
    expect(rejectReason("VALUES (1)")).toBe("not-select");
  });

  it("rejects a chained second statement", () => {
    expect(rejectReason("SELECT * FROM monsters; DROP TABLE monsters")).toBe(
      "multiple-statements"
    );
  });

  it("rejects a chained statement even when the second is also a SELECT", () => {
    expect(rejectReason("SELECT 1 FROM monsters; SELECT 2 FROM monsters")).toBe(
      "multiple-statements"
    );
  });
});

describe("rejected: forbidden keywords (whole word, outside literals)", () => {
  const forbidden = [
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
  for (const kw of forbidden) {
    it(`rejects bare ${kw}`, () => {
      // Place the keyword as a standalone word; the first-keyword check also
      // covers some of these, but all must reject regardless of position.
      expect(rejectReason(`SELECT * FROM monsters WHERE ${kw} x`)).toBe(
        "forbidden-keyword"
      );
    });
  }

  it("does not reject a column whose name merely contains a keyword substring", () => {
    // `dropped` is not the whole word DROP.
    expect(accept("SELECT dropped FROM monsters")).toBeTruthy();
  });
});

describe("rejected: file/network table functions", () => {
  const fns = [
    "read_csv('a.csv')",
    "read_csv_auto('a.csv')",
    "read_parquet('a.parquet')",
    "read_json('a.json')",
    "read_json_auto('a.json')",
    "glob('*.csv')",
    "parquet_scan('a.parquet')",
  ];
  for (const call of fns) {
    it(`rejects ${call}`, () => {
      expect(rejectReason(`SELECT * FROM ${call}`)).toBe("table-function");
    });
  }
});

describe("rejected: bad table positions", () => {
  it("rejects a string-literal path in a table position", () => {
    expect(rejectReason("SELECT * FROM 'data.csv'")).toBe("bad-table-position");
  });

  it("rejects a URL string in a table position", () => {
    expect(rejectReason("SELECT * FROM 'https://evil.example/data.csv'")).toBe(
      "bad-table-position"
    );
  });

  it("rejects a dotted reference whose qualifier is not main", () => {
    expect(rejectReason("SELECT * FROM information_schema.tables")).toBe(
      "bad-table-position"
    );
    expect(rejectReason("SELECT * FROM pg_catalog.pg_tables")).toBe(
      "bad-table-position"
    );
  });

  it("rejects a bare path-like reference (replacement scan)", () => {
    expect(rejectReason("SELECT * FROM data.csv")).toBe("bad-table-position");
  });
});

describe("rejected: unknown tables (incl. comma / join lists)", () => {
  it("rejects an unknown single table", () => {
    expect(rejectReason("SELECT * FROM secrets")).toBe("unknown-table");
  });

  it("rejects an unknown table in a comma list (every ref checked)", () => {
    expect(rejectReason("SELECT * FROM monsters, unknown")).toBe("unknown-table");
  });

  it("rejects a string path in a comma list (every ref checked)", () => {
    expect(rejectReason("SELECT * FROM monsters, 'file.csv'")).toBe(
      "bad-table-position"
    );
  });

  it("rejects an unknown table in a JOIN", () => {
    expect(rejectReason("SELECT * FROM monsters JOIN unknown ON a = b")).toBe(
      "unknown-table"
    );
  });

  it("does not treat a CTE alias as unknown", () => {
    expect(accept("WITH t AS (SELECT * FROM monsters) SELECT * FROM t")).toBeTruthy();
  });
});

describe("FROM-first statements (DuckDB shorthand) are rejected", () => {
  it.each([
    "FROM",
    "from",
    "FROM monsters",
    "FROM monsters SELECT *",
    "FROM monsters SELECT Species LIMIT 1",
    "FROM monsters;",
    "  -- comment\n FROM monsters",
    "FROM (SELECT 1)",
  ])("rejects %j as not-select", (sql) => {
    expect(rejectReason(sql)).toBe("not-select");
  });
  it("still accepts FROM after SELECT or inside WITH", () => {
    accept("SELECT * FROM monsters");
    accept("WITH x AS (SELECT * FROM monsters) SELECT * FROM x");
  });
});


// ── Security hardening (commit A): FROM-list and comment-split bypasses ──────
// Each case below was reported by the read-only audit. They are written to
// FAIL against the unfixed validator when the bypass is real; the notes in
// `.kiro/NOTES-security-hardening.md` record which ones actually passed.

describe("bypass: FROM-list walk must check every reference", () => {
  it.each([
    ["after a subquery", "SELECT * FROM (SELECT 1) q, secret_table"],
    ["after an alias with a column list", "SELECT * FROM monsters AS m(a), secret_table"],
    ["after TABLESAMPLE percent", "SELECT * FROM monsters TABLESAMPLE 10%, secret_table"],
    ["after TABLESAMPLE with a method", "SELECT * FROM monsters TABLESAMPLE bernoulli(10 PERCENT), secret_table"],
    ["after a parenthesized join", "SELECT * FROM (monsters CROSS JOIN experiments) x, secret_table"],
    ["after a second subquery", "SELECT * FROM monsters, (SELECT 1) q, secret_table"],
    ["inside a nested subquery list", "SELECT * FROM (SELECT * FROM (SELECT 1) a, secret_table) b"],
  ])("rejects an unknown table %s", (_name, sql) => {
    expect(validateSql(sql, TABLES).ok).toBe(false);
  });

  it("rejects a parenthesized join whose first table is not allowed", () => {
    expect(validateSql("SELECT * FROM (secret CROSS JOIN monsters)", TABLES).ok).toBe(false);
    expect(validateSql("SELECT * FROM (secret JOIN monsters ON 1 = 1) j", TABLES).ok).toBe(false);
  });

  it("rejects a table function inside parentheses", () => {
    expect(validateSql("SELECT * FROM (range(5))", TABLES).ok).toBe(false);
    expect(validateSql("SELECT * FROM (SUMMARIZE secret_table)", TABLES).ok).toBe(false);
  });
});

describe("bypass: blocked functions in any form", () => {
  it.each([
    ["comment-split after a subquery", "SELECT * FROM (SELECT 1) q, read_/**/csv('https://x/y.csv')"],
    ["quoted lower-case name", `SELECT * FROM "read_csv"('x.csv')`],
    ["quoted upper-case name", `SELECT * FROM "READ_CSV"('x.csv')`],
    ["quoted name after a subquery", `SELECT * FROM (SELECT 1) q, "read_csv"('x.csv')`],
    ["quoted upper-case name after a subquery", `SELECT * FROM (SELECT 1) q, "READ_CSV"('x.csv')`],
    ["unlisted reader sniff_csv", "SELECT * FROM sniff_csv('x.csv')"],
    ["unlisted reader parquet_file_metadata", "SELECT * FROM parquet_file_metadata('x.parquet')"],
    ["query table function", "SELECT * FROM query('SELECT 1')"],
    ["query_table table function", "SELECT * FROM query_table('monsters')"],
    ["generate_series", "SELECT * FROM generate_series(1, 10)"],
    ["a function in a JOIN position", "SELECT * FROM monsters JOIN read_csv('x.csv') ON 1 = 1"],
    ["a function after a comma", "SELECT * FROM monsters, glob('*')"],
    ["a quoted function after TABLESAMPLE", `SELECT * FROM monsters TABLESAMPLE 10%, "read_csv"('x.csv')`],
  ])("rejects %s", (_name, sql) => {
    expect(validateSql(sql, TABLES).ok).toBe(false);
  });

  it("validates the same text it returns (comment splits cannot rebuild a name)", () => {
    const r = validateSql("SELECT 1/**/AS a", TABLES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // A stripped comment becomes a single space, never nothing.
      expect(r.sql).not.toMatch(/1AS/);
      expect(r.sql).toMatch(/1\s+AS/);
    }
    const split = validateSql("SELECT * FROM (SELECT 1) q, read_/**/csv('x.csv')", TABLES);
    if (split.ok) expect(split.sql).not.toMatch(/read_csv/i);
    // Re-validating accepted output must give the same result (fixed point).
    if (r.ok) {
      const again = validateSql(r.sql, TABLES);
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.sql).toBe(r.sql);
    }
  });
});

describe("bypass: NUL bytes", () => {
  it.each([
    ["at the start", "\u0000SELECT * FROM monsters"],
    ["in the middle", "SELECT * FROM mon\u0000sters"],
    ["inside a string literal", "SELECT * FROM monsters WHERE x = 'a\u0000b'"],
    ["inside a comment", "SELECT * FROM monsters -- a\u0000b"],
    ["inside a quoted identifier", `SELECT "a\u0000b" FROM monsters`],
    ["at the end", "SELECT * FROM monsters\u0000"],
  ])("rejects a NUL byte %s", (_name, sql) => {
    expect(validateSql(sql, TABLES).ok).toBe(false);
  });
});

describe("FROM inside functions is not a table position", () => {
  it.each([
    "SELECT EXTRACT(year FROM captured_on) FROM monsters",
    "SELECT extract(year FROM captured_on) AS y FROM monsters",
    "SELECT SUBSTRING(name FROM 1 FOR 3) FROM monsters",
    "SELECT TRIM(BOTH ' ' FROM name) FROM monsters",
    "SELECT TRIM(LEADING 'x' FROM name) FROM monsters",
    "SELECT * FROM monsters WHERE a IS DISTINCT FROM b",
    "SELECT * FROM monsters WHERE a IS NOT DISTINCT FROM b",
    "SELECT EXTRACT(year FROM captured_on), COUNT(*) FROM monsters GROUP BY 1",
  ])("accepts %s", (sql) => {
    expect(validateSql(sql, TABLES).ok).toBe(true);
  });

  it("still rejects an unknown table in the real FROM of such a query", () => {
    expect(validateSql("SELECT EXTRACT(year FROM d) FROM secret_table", TABLES).ok).toBe(false);
    expect(validateSql("SELECT SUBSTRING(a FROM 1) FROM monsters, secret_table", TABLES).ok).toBe(false);
  });
});

describe("accepted shapes still work after the FROM-list rewrite", () => {
  it.each([
    "SELECT * FROM (SELECT * FROM monsters) q",
    "SELECT * FROM (SELECT * FROM monsters) q, experiments",
    "SELECT * FROM monsters AS m(a, b)",
    "SELECT * FROM monsters m, experiments e WHERE m.id = e.id",
    "SELECT * FROM (monsters CROSS JOIN experiments) x",
    "WITH a AS (SELECT * FROM monsters) SELECT * FROM a, experiments",
    "SELECT * FROM monsters m LEFT JOIN experiments e ON m.id = e.id",
  ])("accepts %s", (sql) => {
    expect(validateSql(sql, TABLES).ok).toBe(true);
  });
});

// ── Lexing parity with DuckDB (found while probing DuckDB 1.4.3 in the node bundle) ──

describe("lexing parity with DuckDB", () => {
  it("scans E'...' escape strings the way DuckDB does (backslash escapes the quote)", () => {
    // DuckDB reads E'\'' as ONE string. A plain-string scan would end it early
    // and hide the second statement inside the next "string".
    const sql = "SELECT E'\\'' ; DROP TABLE monsters; SELECT E'x'";
    expect(validateSql(sql, TABLES).ok).toBe(false);
    const toks = tokenize("SELECT E'\\'' AS s");
    expect(toks.filter((t) => t.kind === "string")).toHaveLength(1);
    expect(toks.some((t) => t.kind === "word" && t.text.toUpperCase() === "E")).toBe(false);
    expect(validateSql("SELECT e'a\\\\' AS s FROM monsters", TABLES).ok).toBe(true);
  });

  it("hides nothing behind an E-string whose closing quote is escaped", () => {
    const sql = "SELECT * FROM monsters WHERE x = E'\\'' OR y IN (SELECT 1 FROM secret_table) --'";
    expect(validateSql(sql, TABLES).ok).toBe(false);
  });

  it("ends a line comment at a carriage return like DuckDB does", () => {
    const toks = tokenize("SELECT 1 -- a\rAS x");
    expect(toks.filter((t) => t.kind === "word").map((t) => t.text.toUpperCase())).toEqual(["SELECT", "AS", "X"]);
  });

  it("nests block comments like DuckDB does and leaves no marker behind", () => {
    const r = validateSql("SELECT 1 /* a /* b */ c */ AS x FROM monsters", TABLES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).not.toMatch(/\/\*|\*\//);
  });

  it("rejects a join condition followed by a hidden comma-list table", () => {
    expect(
      validateSql("SELECT * FROM monsters m JOIN experiments e ON m.id = e.id, secret_table", TABLES).ok
    ).toBe(false);
    expect(
      validateSql("SELECT * FROM monsters m LEFT JOIN experiments e ON left(m.a, 1) = e.b, secret_table", TABLES).ok
    ).toBe(false);
    expect(
      validateSql("SELECT * FROM monsters m JOIN experiments e USING (id), secret_table", TABLES).ok
    ).toBe(false);
  });

  it("rejects statement-starting words in parentheses and unbalanced parentheses", () => {
    expect(validateSql("SELECT * FROM (SUMMARIZE secret_table)", TABLES).ok).toBe(false);
    expect(validateSql("SELECT * FROM monsters WHERE x IN (PIVOT secret_table ON y)", TABLES).ok).toBe(false);
    expect(validateSql("SELECT 1) UNION (SELECT 2 FROM secret_table", TABLES).ok).toBe(false);
    expect(validateSql("SELECT * FROM (SELECT * FROM monsters", TABLES).ok).toBe(false);
  });

  it("scopes CTE aliases: a name defined inside a subquery does not shadow a real table outside", () => {
    expect(
      validateSql(
        "SELECT * FROM (WITH secret AS (SELECT 1) SELECT * FROM secret) q, secret",
        TABLES
      ).ok
    ).toBe(false);
    expect(
      validateSql("WITH a AS (SELECT * FROM secret), secret AS (SELECT 1) SELECT * FROM a", TABLES).ok
    ).toBe(false);
    expect(
      validateSql("WITH a AS (SELECT * FROM monsters), b AS (SELECT * FROM a) SELECT * FROM b", TABLES).ok
    ).toBe(true);
  });
});
