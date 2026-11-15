/**
 * Client-side SQL safety validator for "Ask the Lab" (Feature 3, task 1,
 * hardened in security-hardening commit A).
 *
 * This is the safety heart of the feature: EVERY generated query (from the LLM
 * path, a RepairCall, or a deterministic StarterChip) passes through
 * {@link validateSql} before it reaches DuckDB (Req 5.1). The validator is
 * framework-agnostic (no React, DOM, or network) and is unit- and
 * property-tested in isolation.
 *
 * ## Approach
 *
 * 1. NUL bytes are rejected outright (they crash the DuckDB-WASM bundle).
 * 2. A single left-to-right {@link scan} pass separates comments, string
 *    literals, dollar-quoted strings and double-quoted identifiers. Comments are
 *    replaced by ONE SPACE to build the stripped text. The stripped text is
 *    then scanned AGAIN and must produce exactly the same tokens and no
 *    comments. Everything below validates that re-scanned text, and that same
 *    text (minus a trailing `;`, plus a LIMIT) is what is returned and
 *    executed. A comment can therefore never glue two tokens into a different
 *    word after validation (a comment between `read_` and `csv` leaves two
 *    words, never `read_csv`).
 * 3. Statement checks: no non-trailing `;`, first keyword SELECT/WITH, no
 *    forbidden keyword as a whole word outside literals and identifiers.
 * 4. A blocked-function check: any call (`name(`, quoted or not, any case, any
 *    qualifier) to a file, network, introspection or SQL-executing function is
 *    rejected wherever it appears.
 * 5. A structural walk of every query at every depth ({@link analyzeTables}).
 *    It parses FROM clauses (comma lists, joins with ON/USING, parenthesized
 *    joins, subqueries, aliases with column lists, TABLESAMPLE) so that EVERY
 *    table reference is seen. Each must be a queryable table or a CTE alias
 *    that is in scope. A function call in a table position is rejected unless
 *    explicitly allow-listed (the allowlist is empty). `FROM` inside
 *    EXTRACT/SUBSTRING/TRIM/OVERLAY and `IS [NOT] DISTINCT FROM` is not a table
 *    position. Anything the walk cannot parse is rejected (fail closed).
 * 6. LIMIT enforcement: append ASK_DEFAULT_SQL_LIMIT when none is present
 *    (Req 5.7).
 *
 * The executor additionally wraps the accepted SQL with the fetch cap.
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

// ── Blocked functions ────────────────────────────────────────────────────────
// File, network, introspection and SQL-executing functions. Matched on the
// lower-cased name of any call `name(`, quoted or unquoted. The table-position
// rule below is the primary defense (no function call is allowed in a table
// position); this list is defense in depth for every other position.

/** Exact names (lower case). */
const BLOCKED_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "glob",
  "query",
  "query_table",
  "checkpoint",
  "force_checkpoint",
  "enable_logging",
  "disable_logging",
  "truncate_duckdb_logs",
  "which_secret",
  "read_csv",
  "read_csv_auto",
  "read_text",
  "read_blob",
  "sniff_csv",
]);

/** Name patterns (lower case) covering readers and introspection families. */
const BLOCKED_FUNCTION_PATTERNS: readonly RegExp[] = [
  /^read_/, // read_csv, read_parquet, read_json, read_ndjson, read_text, ...
  /_scan$/, // parquet_scan, iceberg_scan, delta_scan, arrow_scan, seq_scan, ...
  /_scan_/, // arrow_scan_dumb and similar
  /^parquet_/, // parquet_metadata, parquet_schema, parquet_file_metadata, ...
  /^sniff_/,
  /^iceberg_/,
  /^delta_/,
  /^duckdb_/, // duckdb_secrets, duckdb_settings, duckdb_extensions, ...
  /^pragma_/,
  /^st_read/,
];

/** Is `name` a function that must never be called from a model-written query? */
export function isBlockedFunctionName(name: string): boolean {
  const lower = name.toLowerCase();
  if (BLOCKED_FUNCTION_NAMES.has(lower)) return true;
  return BLOCKED_FUNCTION_PATTERNS.some((re) => re.test(lower));
}

// ── Grammar word sets (uppercased) ───────────────────────────────────────────

/** Words that may appear before JOIN. */
const JOIN_MODIFIERS: ReadonlySet<string> = new Set([
  "NATURAL",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "CROSS",
  "SEMI",
  "ANTI",
  "ASOF",
  "POSITIONAL",
]);

/** Clause keywords that end a FROM list or a join condition. */
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
  "USING",
  "FETCH",
  "FOR",
]);

/** Words that may NOT be read as a table alias. */
const ALIAS_STOP: ReadonlySet<string> = new Set([
  ...CLAUSE_ENDERS,
  ...JOIN_MODIFIERS,
  "JOIN",
  "ON",
  "TABLESAMPLE",
  "PIVOT",
  "UNPIVOT",
  "SAMPLE",
  "LATERAL",
]);

/** Words that may legally follow a complete FROM list. */
const FROM_FOLLOWERS: ReadonlySet<string> = CLAUSE_ENDERS;

/** Functions whose argument syntax contains a FROM that is not a table position. */
const FROM_FUNCTIONS: ReadonlySet<string> = new Set([
  "EXTRACT",
  "SUBSTRING",
  "SUBSTR",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "OVERLAY",
]);

/**
 * Statement starters that DuckDB accepts inside parentheses but that name a
 * table without a FROM keyword. Rejected in any parenthesized position.
 */
const STATEMENT_STARTERS: ReadonlySet<string> = new Set([
  "PIVOT",
  "UNPIVOT",
  "PIVOT_WIDER",
  "PIVOT_LONGER",
  "SUMMARIZE",
  "DESCRIBE",
  "DESC",
  "SHOW",
  "TABLE",
  "EXPLAIN",
]);

/** Options for {@link validateSql}. */
export interface SqlValidatorOptions {
  /**
   * Table-function names allowed in a FROM/JOIN position (lowercased). Empty by
   * default, so no table function is allowed. The feature never populates this;
   * it exists so a future caller could opt into a vetted function.
   */
  allowedTableFunctions?: ReadonlySet<string>;
}

// ── Scanner ──────────────────────────────────────────────────────────────────

type TokenKind = "word" | "ident" | "string" | "punct";

interface Token {
  kind: TokenKind;
  /**
   * For `word`/`punct`: the raw text. For `ident`: the UNQUOTED inner name. For
   * `string`: the UNQUOTED inner text (not used for safety, kept for clarity).
   */
  text: string;
}

/** A comment span `[start, end)` in the scanned text. */
type Span = readonly [number, number];

const WORD_START = /[A-Za-z_]/;
const WORD_CHAR = /[A-Za-z0-9_$]/;
/** Sticky: matches `$tag$` (or `$$`) at `lastIndex` only. */
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

/**
 * Scan SQL into tokens and comment spans. Comments produce no token. String
 * literals, dollar-quoted strings and double-quoted identifiers are their own
 * token kinds, so a forbidden word inside them can never trigger a rejection
 * and never hides a real word.
 */
function scan(sql: string): { tokens: Token[]; comments: Span[] } {
  const tokens: Token[] = [];
  const comments: Span[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    // Whitespace.
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }

    // Line comment: -- ... up to a line break. DuckDB ends it at "\n" OR "\r",
    // so both end it here (the line break itself stays).
    if (c === "-" && sql[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
      comments.push([start, i]);
      continue;
    }

    // Block comment: /* ... */. DuckDB nests them, so this does too. An
    // unterminated one runs to the end of the text.
    if (c === "/" && sql[i + 1] === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      comments.push([start, Math.min(i, n)]);
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

    // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty: $$ ... $$).
    if (c === "$") {
      DOLLAR_TAG.lastIndex = i;
      const tagMatch = DOLLAR_TAG.exec(sql);
      if (tagMatch) {
        const delim = tagMatch[0];
        const start = i + delim.length;
        const end = sql.indexOf(delim, start);
        const stop = end === -1 ? n : end;
        tokens.push({ kind: "string", text: sql.slice(start, stop) });
        i = end === -1 ? n : end + delim.length;
        continue;
      }
      // A lone `$` not opening a dollar-quote is punctuation.
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

      // Escape string E'...': DuckDB treats a backslash as an escape inside it,
      // so `E'\''` is ONE string. Scanning it as a plain string would end it
      // early and hide the following text, so it is scanned its own way.
      if ((text === "E" || text === "e") && sql[i] === "'") {
        i++;
        let body = "";
        while (i < n) {
          if (sql[i] === "\\" && i + 1 < n) {
            body += sql[i] + sql[i + 1];
            i += 2;
            continue;
          }
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") {
              body += "'";
              i += 2;
              continue;
            }
            i++; // closing quote
            break;
          }
          body += sql[i++];
        }
        tokens.push({ kind: "string", text: body });
        continue;
      }

      tokens.push({ kind: "word", text });
      continue;
    }

    // Everything else is single-char punctuation (including `.` `,` `(` `)` `;`).
    tokens.push({ kind: "punct", text: c });
    i++;
  }

  return { tokens, comments };
}

/**
 * Tokenize SQL into a stream that omits comments and isolates string literals,
 * dollar-quoted strings, and double-quoted identifiers as their own kinds.
 */
export function tokenize(sql: string): Token[] {
  return scan(sql).tokens;
}

/** Replace each comment span with a single space (never with nothing). */
function replaceComments(sql: string, comments: readonly Span[]): string {
  let out = "";
  let at = 0;
  for (const [start, end] of comments) {
    out += sql.slice(at, start) + " ";
    at = end;
  }
  return out + sql.slice(at);
}

function sameTokens(a: readonly Token[], b: readonly Token[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k].kind !== b[k].kind || a[k].text !== b[k].text) return false;
  }
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fail(reason: SqlRejectReason): SqlValidationResult {
  return { ok: false, reason };
}

/** Internal control-flow exception carrying a rejection reason. */
class Reject extends Error {
  reason: SqlRejectReason;
  constructor(reason: SqlRejectReason) {
    super(reason);
    this.reason = reason;
  }
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

// ── Main validator ───────────────────────────────────────────────────────

/**
 * Validate a single read-only SQL statement over the given queryable table
 * names. Returns the accepted SQL (comments replaced by spaces, LIMIT
 * enforced) or a rejection reason. See the module header for the algorithm.
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
  // 0. NUL bytes crash the DuckDB-WASM bundle and have no legitimate use.
  if (sql.includes("\u0000")) return fail("invalid-character");

  // 1. Strip comments to single spaces, then validate the STRIPPED text. The
  //    re-scan must agree token for token and must find no comment left, so the
  //    text that runs is exactly the text that was validated.
  const first = scan(sql);
  const stripped = replaceComments(sql, first.comments);
  const second = scan(stripped);
  if (second.comments.length > 0 || !sameTokens(first.tokens, second.tokens)) {
    return fail("unparseable");
  }
  const tokens = second.tokens;

  // Drop a single trailing `;` token for analysis (a trailing terminator is OK).
  const analysis = [...tokens];
  const last = analysis[analysis.length - 1];
  const trailingSemicolon = last !== undefined && last.kind === "punct" && last.text === ";";
  if (trailingSemicolon) analysis.pop();

  if (analysis.length === 0) return fail("empty");

  // 2a. No further `;` anywhere: a non-trailing semicolon means a 2nd statement.
  for (const t of analysis) {
    if (t.kind === "punct" && t.text === ";") return fail("multiple-statements");
  }

  // 2b. First significant word must be SELECT or WITH.
  const firstWord = analysis.find((t) => t.kind === "word");
  if (!firstWord) return fail("not-select");
  const firstUpper = firstWord.text.toUpperCase();
  if (firstUpper !== "SELECT" && firstUpper !== "WITH") return fail("not-select");

  // 3. Forbidden keywords (whole word, outside literals and identifiers).
  for (const t of analysis) {
    if (t.kind === "word" && FORBIDDEN_KEYWORDS.has(t.text.toUpperCase())) {
      return fail("forbidden-keyword");
    }
  }

  // 4. Blocked functions: any call, quoted or not, wherever it appears.
  for (let k = 0; k + 1 < analysis.length; k++) {
    const t = analysis[k];
    if (t.kind !== "word" && t.kind !== "ident") continue;
    const next = analysis[k + 1];
    if (next.kind === "punct" && next.text === "(" && isBlockedFunctionName(t.text)) {
      return fail("table-function");
    }
  }

  // 5. Structural table walk.
  const known = new Set<string>();
  for (const name of queryableTableNames) known.add(name.toLowerCase());
  const allowedFns = new Set<string>();
  for (const f of options.allowedTableFunctions ?? []) allowedFns.add(f.toLowerCase());
  try {
    analyzeTables(analysis, known, allowedFns);
  } catch (e) {
    if (e instanceof Reject) return fail(e.reason);
    // Anything unexpected (for example a stack overflow on absurd nesting)
    // fails closed.
    return fail("unparseable");
  }

  // 6. Enforce LIMIT when absent.
  const hasLimit = analysis.some((t) => t.kind === "word" && t.text.toUpperCase() === "LIMIT");
  let text = stripped.trim();
  if (trailingSemicolon) text = text.slice(0, -1).trimEnd();
  const out = hasLimit ? text : `${text} LIMIT ${ASK_DEFAULT_SQL_LIMIT}`;
  return { ok: true, sql: out };
}

// ── Table analysis ───────────────────────────────────────────────────────────

/**
 * Walk every query in `tokens` and throw {@link Reject} on the first table
 * reference that is not allowed. See the module header, step 5.
 */
function analyzeTables(
  tokens: readonly Token[],
  known: ReadonlySet<string>,
  allowedFns: ReadonlySet<string>
): void {
  const n = tokens.length;

  // Matching parentheses, computed once. Unbalanced parentheses are rejected.
  const match = new Array<number>(n).fill(-1);
  {
    const stack: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = tokens[k];
      if (t.kind !== "punct") continue;
      if (t.text === "(") stack.push(k);
      else if (t.text === ")") {
        const open = stack.pop();
        if (open === undefined) throw new Reject("unparseable");
        match[open] = k;
      }
    }
    if (stack.length > 0) throw new Reject("unparseable");
  }

  const isPunct = (k: number, text: string): boolean =>
    k >= 0 && k < n && tokens[k].kind === "punct" && tokens[k].text === text;

  /** Upper-cased text when token `k` is a bare word, else null. */
  const wordUpper = (k: number): string | null =>
    k >= 0 && k < n && tokens[k].kind === "word" ? tokens[k].text.toUpperCase() : null;

  const isNameToken = (k: number): boolean =>
    k >= 0 && k < n && (tokens[k].kind === "word" || tokens[k].kind === "ident");

  /** A leading statement-starter inside parentheses is never allowed. */
  const rejectStatementStarter = (k: number): void => {
    const w = wordUpper(k);
    if (w !== null && STATEMENT_STARTERS.has(w)) throw new Reject("bad-table-position");
  };

  // Query: optional WITH list, then the body.
  function checkQuery(s: number, e: number, ctes: ReadonlySet<string>): void {
    let i = s;
    rejectStatementStarter(i);
    let visible: ReadonlySet<string> = ctes;
    if (wordUpper(i) === "WITH") {
      i++;
      let recursive = false;
      if (wordUpper(i) === "RECURSIVE") {
        recursive = true;
        i++;
      }
      for (;;) {
        if (!isNameToken(i)) throw new Reject("bad-table-position");
        const name = tokens[i].text.toLowerCase();
        i++;
        if (isPunct(i, "(")) i = match[i] + 1; // column list
        if (wordUpper(i) !== "AS") throw new Reject("bad-table-position");
        i++;
        if (wordUpper(i) === "NOT") i++;
        if (wordUpper(i) === "MATERIALIZED") i++;
        if (!isPunct(i, "(")) throw new Reject("bad-table-position");
        const close = match[i];
        // A CTE body sees only EARLIER aliases (and itself when RECURSIVE).
        const scope = new Set(visible);
        if (recursive) scope.add(name);
        checkQuery(i + 1, close, scope);
        const next = new Set(visible);
        next.add(name);
        visible = next;
        i = close + 1;
        if (isPunct(i, ",")) {
          i++;
          continue;
        }
        break;
      }
    }
    scanRange(i, e, visible, false);
  }

  // Scan a token range for FROM clauses and nested parenthesized ranges.
  function scanRange(s: number, e: number, ctes: ReadonlySet<string>, fnFrom: boolean): void {
    let i = s;
    let fnFromUsed = false;
    while (i < e) {
      const t = tokens[i];
      if (t.kind === "punct" && t.text === "(") {
        const close = match[i];
        rejectStatementStarter(i + 1);
        const first = wordUpper(i + 1);
        if (first === "SELECT" || first === "WITH" || first === "VALUES") {
          checkQuery(i + 1, close, ctes);
        } else {
          const prev = i > 0 && tokens[i - 1].kind === "word" ? tokens[i - 1].text.toUpperCase() : "";
          scanRange(i + 1, close, ctes, FROM_FUNCTIONS.has(prev));
        }
        i = close + 1;
        continue;
      }
      if (t.kind === "word") {
        const up = t.text.toUpperCase();
        if (up === "FROM") {
          const prev = wordUpper(i - 1);
          const prev2 = wordUpper(i - 2);
          const distinctFrom = prev === "DISTINCT" && (prev2 === "IS" || prev2 === "NOT");
          if (distinctFrom || (fnFrom && !fnFromUsed)) {
            if (!distinctFrom) fnFromUsed = true;
            i++;
            continue;
          }
          i = parseFromClause(i + 1, e, ctes);
          continue;
        }
        if (up === "JOIN") {
          // A JOIN is always consumed by parseFromClause. A stray one is malformed.
          throw new Reject("bad-table-position");
        }
      }
      i++;
    }
  }

  // FROM list: table_ref (join_spec)* (',' table_ref (join_spec)*)*
  function parseFromClause(start: number, e: number, ctes: ReadonlySet<string>): number {
    let i = start;
    for (;;) {
      i = parseTableRef(i, e, ctes);
      for (;;) {
        const j = joinKeywordIndex(i, e);
        if (j < 0) break;
        i = parseTableRef(j + 1, e, ctes);
        if (wordUpper(i) === "ON" && i < e) {
          const end = expressionEnd(i + 1, e);
          scanRange(i + 1, end, ctes, false);
          i = end;
        } else if (wordUpper(i) === "USING" && isPunct(i + 1, "(") && i < e) {
          const close = match[i + 1];
          scanRange(i + 2, close, ctes, false);
          i = close + 1;
        }
      }
      if (i < e && isPunct(i, ",")) {
        i++;
        continue;
      }
      break;
    }
    // After a complete FROM list only a clause keyword may follow.
    if (i < e) {
      const w = wordUpper(i);
      if (w === null || !FROM_FOLLOWERS.has(w)) throw new Reject("bad-table-position");
    }
    return i;
  }

  /** Index of the JOIN word when `i` starts a join (modifiers then JOIN), else -1. */
  function joinKeywordIndex(i: number, e: number): number {
    let j = i;
    let sawModifier = false;
    while (j < e && wordUpper(j) !== null && JOIN_MODIFIERS.has(wordUpper(j) as string)) {
      sawModifier = true;
      j++;
    }
    if (j < e && wordUpper(j) === "JOIN") return j;
    if (sawModifier) throw new Reject("bad-table-position");
    return -1;
  }

  /** End of a join condition expression starting at `i` (exclusive). */
  function expressionEnd(i: number, e: number): number {
    let k = i;
    while (k < e) {
      const t = tokens[k];
      if (t.kind === "punct") {
        if (t.text === "(") {
          k = match[k] + 1;
          continue;
        }
        if (t.text === ",") return k;
      } else if (t.kind === "word") {
        const up = t.text.toUpperCase();
        const isStop = up === "JOIN" || JOIN_MODIFIERS.has(up) || CLAUSE_ENDERS.has(up);
        // LEFT( and RIGHT( are functions, not joins.
        if (isStop && !((up === "LEFT" || up === "RIGHT") && isPunct(k + 1, "("))) return k;
      }
      k++;
    }
    return e;
  }

  // One table reference plus its alias, column list and TABLESAMPLE.
  function parseTableRef(start: number, e: number, ctes: ReadonlySet<string>): number {
    let i = start;
    if (i >= e) throw new Reject("bad-table-position");
    if (wordUpper(i) === "LATERAL") i++;
    if (i >= e) throw new Reject("bad-table-position");
    const t = tokens[i];

    if (t.kind === "punct" && t.text === "(") {
      const close = match[i];
      rejectStatementStarter(i + 1);
      const first = wordUpper(i + 1);
      if (first === "SELECT" || first === "WITH" || first === "VALUES") {
        checkQuery(i + 1, close, ctes);
      } else if (first === "FROM") {
        scanRange(i + 1, close, ctes, false);
      } else {
        // A parenthesized join: it must be consumed exactly.
        const end = parseFromClause(i + 1, close, ctes);
        if (end !== close) throw new Reject("bad-table-position");
      }
      return skipTableSample(skipAlias(close + 1, e, ctes), e);
    }

    if (t.kind === "string" || (t.kind !== "word" && t.kind !== "ident")) {
      throw new Reject("bad-table-position");
    }

    // Dotted name: a(.b)*
    const parts: Token[] = [t];
    let k = i + 1;
    while (isPunct(k, ".") && isNameToken(k + 1)) {
      parts.push(tokens[k + 1]);
      k += 2;
    }
    if (isPunct(k, ".")) throw new Reject("bad-table-position");

    // A call in a table position is a table function: rejected unless allow-listed.
    if (isPunct(k, "(")) {
      const fn = parts[parts.length - 1].text.toLowerCase();
      if (parts.length !== 1 || !allowedFns.has(fn)) throw new Reject("table-function");
      return skipTableSample(skipAlias(match[k] + 1, e, ctes), e);
    }

    if (parts.length === 1) {
      const name = parts[0].text;
      if (looksLikePath(name)) throw new Reject("bad-table-position");
      const lower = name.toLowerCase();
      if (!ctes.has(lower) && !known.has(lower)) throw new Reject("unknown-table");
    } else if (parts.length === 2) {
      if (parts[0].text.toLowerCase() !== "main") throw new Reject("bad-table-position");
      if (!known.has(parts[1].text.toLowerCase())) throw new Reject("unknown-table");
    } else {
      throw new Reject("bad-table-position");
    }
    return skipTableSample(skipAlias(k, e, ctes), e);
  }

  // Optional `[AS] alias [(col, ...)]`. A parenthesized tail is scanned so a
  // subquery hidden there is still checked.
  function skipAlias(start: number, e: number, ctes: ReadonlySet<string>): number {
    let k = start;
    let hasAlias = false;
    if (k < e && wordUpper(k) === "AS") {
      k++;
      if (k >= e || !isNameToken(k)) throw new Reject("bad-table-position");
      k++;
      hasAlias = true;
    } else if (k < e && isNameToken(k)) {
      const up = wordUpper(k);
      if (up === null || !ALIAS_STOP.has(up)) {
        k++;
        hasAlias = true;
      }
    }
    if (hasAlias && k < e && isPunct(k, "(")) {
      const close = match[k];
      scanRange(k + 1, close, ctes, false);
      k = close + 1;
    }
    return k;
  }

  // Optional TABLESAMPLE clause: skip to the next comma, join, clause keyword
  // or the end. Parenthesized arguments are skipped as a unit.
  function skipTableSample(start: number, e: number): number {
    if (start >= e || wordUpper(start) !== "TABLESAMPLE") return start;
    let k = start + 1;
    while (k < e) {
      const t = tokens[k];
      if (t.kind === "punct" && t.text === ",") break;
      if (t.kind === "punct" && t.text === "(") {
        k = match[k] + 1;
        continue;
      }
      if (t.kind === "word") {
        const up = t.text.toUpperCase();
        if (up === "JOIN" || JOIN_MODIFIERS.has(up) || CLAUSE_ENDERS.has(up)) break;
      }
      k++;
    }
    return k;
  }

  checkQuery(0, n, new Set());
}
