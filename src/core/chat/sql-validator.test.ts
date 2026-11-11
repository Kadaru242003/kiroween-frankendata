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
