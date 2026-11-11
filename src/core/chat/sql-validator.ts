/**
 * Client-side SQL safety validator for "Ask the Lab" (Feature 3, task 1).
 *
 * This is the safety heart of the feature: EVERY generated query — from the LLM
 * path, a RepairCall, or a deterministic StarterChip — passes through
 * {@link validateSql} before it reaches DuckDB (Req 5.1). The validator is
 * framework-agnostic (no React, DOM, or network) and is unit- and
 * property-tested in isolation.
 *
 * ## Approach (design: "SqlValidator algorithm")
 *
 * A single left-to-right {@link tokenize} pass strips comments and separates
 * string literals, dollar-quoted strings, and double-quoted identifiers into
 * their OWN token kinds, so their inner text is opaque to every subsequent
 * check. All keyword and table analysis then runs on the token stream using
 * WHOLE-WORD comparisons — never a substring scan of the raw SQL. That is what
 * makes `WHERE status = 'Load'` and a column named `"set"` safe: the forbidden
 * word lives inside a `string`/`ident` token, not a `word` token (Req 5.4).
 *
 * The checks, in order:
 *   1. single read-only statement: no non-trailing `;`, first keyword
 *      SELECT/WITH (Req 5.2, 5.3)
 *   2. forbidden keywords (whole word, outside literals/identifiers) (Req 5.4)
 *   3. file/network table functions (whole word before `(`) (Req 5.5)
 *   4. FROM/JOIN table positions: reject string/quoted-path positions, reject
 *      table-function calls not on the (empty-by-default) allowlist, reject
 *      replacement-scan refs, check EVERY comma-separated reference, reject
 *      dotted refs unless the qualifier is exactly `main`; collect referenced
 *      tables (Req 5.6)
 *   5. table allowlisting: CTE aliases declared in the same WITH are allowed;
 *      every other referenced table must be a QueryableTable (Req 5.6)
 *   6. LIMIT enforcement: append ASK_DEFAULT_SQL_LIMIT when none is present
 *      (Req 5.7)
 *
 * The accepted SQL returned is comment-stripped and trailing-`;`-trimmed with
 * the LIMIT enforced; it is what the executor wraps (ASK_MAX_FETCH_ROWS) and
 * runs.
 */

import { ASK_DEFAULT_SQL_LIMIT } from "./types.js";
import type { SqlValidationResult, SqlRejectReason } from "./types.js";

// ── Forbidden keywords (whole word, uppercased) ─────────────────────────────
const FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set([
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
]);

// ── Blocked file/network table functions (whole word before `(`) ───────────
const BLOCKED_TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  "read_csv",
  "read_csv_auto",
  "read_parquet",
  "parquet_scan",
  "read_json",
  "read_json_auto",
  "read_json_objects",
  "read_ndjson",
  "read_ndjson_auto",
  "read_ndjson_objects",
  "read_text",
  "read_blob",
  "csv_scan",
  "glob",
  "iceberg_scan",
  "delta_scan",
  "parquet_metadata",
  "parquet_schema",
]);

// Clause-ending keywords that terminate a FROM reference list (Req 5.6 comma
// handling). Uppercased.
const CLAUSE_ENDERS: ReadonlySet<string> = new Set([
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "WINDOW",
  "QUALIFY",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "ON",
  "USING",
  "NATURAL",
]);

/** Options for {@link validateSql}. */
export interface SqlValidatorOptions {
  /**
   * Table-function names allowed in a FROM/JOIN position (lowercased). Empty by
   * default — no table function is allowed. The feature never populates this;
   * it exists so a future caller could opt into a vetted function.
   */
  allowedTableFunctions?: ReadonlySet<string>;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

type TokenKind = "word" | "ident" | "string" | "punct";

interface Token {
  kind: TokenKind;
  /**
   * For `word`/`punct`: the raw text. For `ident`: the UNQUOTED inner name. For
   * `string`: the UNQUOTED inner text (not used for safety, kept for clarity).
   */
  text: string;
}

const WORD_START = /[A-Za-z_]/;
const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Tokenize SQL into a stream that strips comments and isolates string literals,
 * dollar-quoted strings, and double-quoted identifiers as their own kinds.
 * Keyword analysis only ever looks at `word` tokens, so a forbidden word inside
 * a `string`/`ident` can never trigger a rejection.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    // Whitespace.
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }

    // Line comment: -- … to end of line.
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment: /* … */ (not nested; DuckDB does not nest).
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2; // skip the closing */ (past-end is harmless)
      continue;
    }

    // Single-quoted string literal, with '' escape.
    if (c === "'") {
      i++;
      let text = "";
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            text += "'";
            i += 2;
            continue;
          }
          i++; // closing quote
          break;
        }
        text += sql[i++];
      }
      tokens.push({ kind: "string", text });
      continue;
    }

    // Dollar-quoted string: $tag$ … $tag$ (tag may be empty: $$ … $$).
    if (c === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const delim = tagMatch[0];
        const start = i + delim.length;
        const end = sql.indexOf(delim, start);
        const stop = end === -1 ? n : end;
        tokens.push({ kind: "string", text: sql.slice(start, stop) });
        i = end === -1 ? n : end + delim.length;
        continue;
      }
      // A lone `$` not opening a dollar-quote → punctuation.
      tokens.push({ kind: "punct", text: "$" });
      i++;
      continue;
    }

    // Double-quoted identifier, with "" escape.
    if (c === '"') {
      i++;
      let text = "";
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            text += '"';
            i += 2;
            continue;
          }
          i++; // closing quote
          break;
        }
        text += sql[i++];
      }
      tokens.push({ kind: "ident", text });
      continue;
    }

    // Bare word (keyword / unquoted identifier / function name).
    if (WORD_START.test(c)) {
      let text = c;
      i++;
      while (i < n && WORD_CHAR.test(sql[i])) text += sql[i++];
      tokens.push({ kind: "word", text });
      continue;
    }

    // Everything else is single-char punctuation (including `.` `,` `(` `)` `;`).
    tokens.push({ kind: "punct", text: c });
    i++;
  }

  return tokens;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isWord(t: Token | undefined, upper: string): boolean {
  return !!t && t.kind === "word" && t.text.toUpperCase() === upper;
}

function fail(reason: SqlRejectReason): SqlValidationResult {
  return { ok: false, reason };
}

/** Strip comments (via tokenizer) and a single trailing `;` from raw SQL. */
function stripForOutput(sql: string): string {
  // Re-serialize is lossy; instead strip comments textually in a second pass
  // that mirrors the tokenizer's comment handling but preserves everything
  // else verbatim, then trim a trailing semicolon. This keeps the executed SQL
  // faithful to the model's intent (spacing, casing) minus comments.
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out.trim().replace(/;\s*$/, "").trim();
}

// ── Main validator ───────────────────────────────────────────────────────

/**
 * Validate a single read-only SQL statement over the given queryable table
 * names. Returns the accepted SQL (comment-stripped, LIMIT-enforced) or a
 * rejection reason. See the module header for the full algorithm.
 *
 * @param sql The candidate SQL.
 * @param queryableTableNames The sanitized DuckDB names of the current
 *   QueryableTables (case-insensitive match).
 */
export function validateSql(
  sql: string,
  queryableTableNames: Iterable<string>,
  options: SqlValidatorOptions = {}
): SqlValidationResult {
  const allowedFns = options.allowedTableFunctions ?? new Set<string>();
  const known = new Set<string>();
  for (const name of queryableTableNames) known.add(name.toLowerCase());

  const tokens = tokenize(sql);

  // Drop a single trailing-`;` token for analysis (a trailing terminator is OK).
  const analysis = [...tokens];
  if (analysis.length > 0 && analysis[analysis.length - 1].kind === "punct" && analysis[analysis.length - 1].text === ";") {
    analysis.pop();
  }

  if (analysis.length === 0) return fail("empty");

  // 1a. No further `;` anywhere → a non-trailing semicolon means a 2nd statement.
  for (const t of analysis) {
    if (t.kind === "punct" && t.text === ";") return fail("multiple-statements");
  }

  // 1b. First significant word must be SELECT or WITH.
  const firstWord = analysis.find((t) => t.kind === "word");
  if (!firstWord) return fail("not-select");
  const firstUpper = firstWord.text.toUpperCase();
  if (firstUpper !== "SELECT" && firstUpper !== "WITH") return fail("not-select");

  // 2. Forbidden keywords (whole word, outside literals/identifiers).
  for (const t of analysis) {
    if (t.kind === "word" && FORBIDDEN_KEYWORDS.has(t.text.toUpperCase())) {
      return fail("forbidden-keyword");
    }
  }

  // 3. File/network table functions (a blocked word immediately before `(`).
  for (let k = 0; k < analysis.length; k++) {
    const t = analysis[k];
    if (t.kind !== "word") continue;
    const next = analysis[k + 1];
    const isCall = next && next.kind === "punct" && next.text === "(";
    if (isCall && BLOCKED_TABLE_FUNCTIONS.has(t.text.toLowerCase())) {
      return fail("table-function");
    }
  }

  // 4. CTE aliases declared by WITH … AS (…) are valid references.
  const cteAliases = collectCteAliases(analysis);

  // 5. Table positions after FROM / JOIN.
  const referenced: string[] = [];
  for (let k = 0; k < analysis.length; k++) {
    const t = analysis[k];
    if (t.kind !== "word") continue;
    const upper = t.text.toUpperCase();
    const isFrom = upper === "FROM";
    const isJoin = upper === "JOIN";
    if (!isFrom && !isJoin) continue;

    // Collect one reference (JOIN) or a comma-separated list (FROM).
    let j = k + 1;
    while (true) {
      const refResult = readTableReference(analysis, j, allowedFns);
      if (!refResult.ok) return fail(refResult.reason);
      if (refResult.name !== null) referenced.push(refResult.name.toLowerCase());
      j = refResult.next;

      if (!isFrom) break; // JOIN takes exactly one reference

      // In a FROM list, continue only across a top-level comma.
      const sep = analysis[j];
      if (sep && sep.kind === "punct" && sep.text === ",") {
        j++;
        continue;
      }
      break;
    }
  }

  // 6. Every referenced table must be a CTE alias or a QueryableTable.
  for (const name of referenced) {
    if (cteAliases.has(name)) continue;
    if (!known.has(name)) return fail("unknown-table");
  }

  // 7. Enforce LIMIT when absent (top-level LIMIT word token present?).
  const hasLimit = analysis.some((t) => t.kind === "word" && t.text.toUpperCase() === "LIMIT");
  const cleaned = stripForOutput(sql);
  const out = hasLimit ? cleaned : `${cleaned} LIMIT ${ASK_DEFAULT_SQL_LIMIT}`;
  return { ok: true, sql: out };
}

/**
 * Read a single table reference starting at index `start` (the token right
 * after FROM/JOIN). Returns the (lowercased-by-caller) referenced table name
 * plus the index just past the reference and its optional alias, or a rejection.
 *
 * Rejections (Req 5.6):
 *   - a `string` token in a table position (`FROM 'data.csv'`)
 *   - a table-FUNCTION call (word before `(`) not on the allowlist
 *   - a dotted reference whose qualifier is not exactly `main`
 *   - a subquery `(` here yields `name: null` (nothing to allowlist — its inner
 *     FROM/JOIN tokens are still visited by the outer scan)
 */
function readTableReference(
  tokens: Token[],
  start: number,
  allowedFns: ReadonlySet<string>
):
  | { ok: true; name: string | null; next: number }
  | { ok: false; reason: SqlRejectReason } {
  let j = start;
  const t = tokens[j];

  if (!t) {
    // Nothing after FROM/JOIN — malformed; treat as a bad table position.
    return { ok: false, reason: "bad-table-position" };
  }

  // A subquery or parenthesized join: `(` — not a table name. Skip the token;
  // the outer scan still visits its inner FROM/JOIN words.
  if (t.kind === "punct" && t.text === "(") {
    return { ok: true, name: null, next: j + 1 };
  }

  // A string / dollar-quoted path in a table position is always rejected.
  if (t.kind === "string") {
    return { ok: false, reason: "bad-table-position" };
  }

  // A word or quoted identifier names a table (or a table function).
  if (t.kind === "word" || t.kind === "ident") {
    // Table-function call: word immediately followed by `(`.
    const next = tokens[j + 1];
    if (t.kind === "word" && next && next.kind === "punct" && next.text === "(") {
      if (!allowedFns.has(t.text.toLowerCase())) {
        return { ok: false, reason: "table-function" };
      }
      // Allowed function: skip the balanced (...) and any alias.
      const afterCall = skipBalancedParens(tokens, j + 1);
      return { ok: true, name: null, next: skipAlias(tokens, afterCall) };
    }

    // Dotted reference: qualifier.name — allowed only when qualifier is `main`.
    const dot = tokens[j + 1];
    if (dot && dot.kind === "punct" && dot.text === ".") {
      const second = tokens[j + 2];
      if (!second || (second.kind !== "word" && second.kind !== "ident")) {
        return { ok: false, reason: "bad-table-position" };
      }
      if (t.text.toLowerCase() !== "main") {
        return { ok: false, reason: "bad-table-position" };
      }
      // Guard against a 3-part name (catalog.schema.table): still require `main`.
      const nameToken = second;
      j = j + 3;
      return { ok: true, name: nameToken.text, next: skipAlias(tokens, j) };
    }

    // A replacement-scan style bare reference: a name that looks like a path/URL.
    if (looksLikePath(t.text)) {
      return { ok: false, reason: "bad-table-position" };
    }

    // Plain table reference.
    return { ok: true, name: t.text, next: skipAlias(tokens, j + 1) };
  }

  // Any other punctuation in a table position is malformed.
  return { ok: false, reason: "bad-table-position" };
}

/** Does a bare identifier look like a file path / URL (replacement scan)? */
function looksLikePath(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("/") ||
    lower.includes("\\") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".parquet") ||
    lower.endsWith(".json") ||
    lower.includes("://")
  );
}

/** Skip an optional `AS alias` or bare `alias` after a reference. */
function skipAlias(tokens: Token[], j: number): number {
  const t = tokens[j];
  if (!t) return j;
  if (t.kind === "word" && t.text.toUpperCase() === "AS") {
    // AS <alias>
    return tokens[j + 1] ? j + 2 : j + 1;
  }
  // A bare alias (word/ident) that is not a clause-ender and not a comma/keyword.
  if (t.kind === "ident") return j + 1;
  if (t.kind === "word" && !CLAUSE_ENDERS.has(t.text.toUpperCase())) {
    return j + 1;
  }
  return j;
}

/** Given the index of an opening `(`, return the index just past its match. */
function skipBalancedParens(tokens: Token[], openIdx: number): number {
  let depth = 0;
  let j = openIdx;
  for (; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return j;
}

/**
 * Collect CTE alias names from a leading `WITH alias AS (…) [, alias2 AS (…)]`.
 * Only the aliases at the top level of the WITH list matter; nested WITHs
 * inside a CTE body still produce referenced tables that are either their own
 * (inner) aliases or QueryableTables, which the outer allowlist check covers
 * conservatively. Returns lowercased names.
 */
function collectCteAliases(tokens: Token[]): Set<string> {
  const aliases = new Set<string>();
  if (!isWord(tokens[0], "WITH")) return aliases;

  let j = 1;
  // Optional RECURSIVE.
  if (isWord(tokens[j], "RECURSIVE")) j++;

  while (j < tokens.length) {
    const nameTok = tokens[j];
    if (!nameTok || (nameTok.kind !== "word" && nameTok.kind !== "ident")) break;
    // Expect: alias [ (cols...) ] AS ( body )
    let k = j + 1;
    if (tokens[k] && tokens[k].kind === "punct" && tokens[k].text === "(") {
      k = skipBalancedParens(tokens, k); // column list
    }
    if (!isWord(tokens[k], "AS")) break;
    k++;
    if (!(tokens[k] && tokens[k].kind === "punct" && tokens[k].text === "(")) break;
    aliases.add(nameTok.text.toLowerCase());
    k = skipBalancedParens(tokens, k); // CTE body
    // Another CTE after a comma?
    if (tokens[k] && tokens[k].kind === "punct" && tokens[k].text === ",") {
      j = k + 1;
      continue;
    }
    break;
  }
  return aliases;
}
