/**
 * Recipe validator (Feature 5, Requirement 3).
 *
 * A recipe file is UNTRUSTED input. This module checks it against the strict,
 * versioned schema and returns either a typed {@link Recipe} built from FRESH
 * plain objects (so a hostile document cannot smuggle extra properties or
 * pollute prototypes) or a list of issues with JSON paths. It is total: it
 * never throws and has no side effects. It never evaluates anything.
 */
import {
  RECIPE_FORMAT,
  RECIPE_MAX_BYTES,
  RECIPE_MAX_COLUMNS_PER_TABLE,
  RECIPE_MAX_ITEMS,
  RECIPE_MAX_NAME_LENGTH,
  RECIPE_MAX_TABLES,
  RECIPE_MAX_VALUE_LENGTH,
  RECIPE_VERSION,
} from "./types";
import type {
  Recipe,
  RecipeCleaning,
  RecipeColumnRef,
  RecipeIssue,
  RecipeJoinKey,
  RecipeMatch,
  RecipeRule,
  RecipeTable,
  ValidationResult,
} from "./types";
import type { ColumnType } from "../types";

const MAX_ISSUES = 50;
const COLUMN_TYPES: readonly string[] = ["number", "boolean", "date", "string"];
const RULES: readonly string[] = [
  "whitespace",
  "case",
  "category",
  "duplicate-rows",
  "outliers",
];
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

class Issues {
  readonly list: RecipeIssue[] = [];
  add(path: string, message: string): void {
    if (this.list.length < MAX_ISSUES) {
      this.list.push({ path, message });
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own enumerable string keys only. */
function keysOf(o: Record<string, unknown>): string[] {
  return Object.keys(o);
}

/** Check that `o` has exactly the allowed keys (required ones present). */
function checkKeys(
  o: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  issues: Issues
): void {
  const allowed = new Set([...required, ...optional]);
  for (const k of keysOf(o)) {
    if (!allowed.has(k)) {
      issues.add(`${path}.${safeKey(k)}`, "Unknown field.");
    }
  }
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) {
      issues.add(`${path}.${k}`, "Required field is missing.");
    }
  }
}

/** Keep a hostile key from producing an enormous or odd path string. */
function safeKey(k: string): string {
  const trimmed = k.length > 40 ? `${k.slice(0, 40)}...` : k;
  return trimmed.replace(/[\u0000-\u001f]/g, "?");
}

function getOwn(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

function checkName(
  v: unknown,
  path: string,
  issues: Issues,
  maxLen: number = RECIPE_MAX_NAME_LENGTH
): string | null {
  if (typeof v !== "string") {
    issues.add(path, "Must be a string.");
    return null;
  }
  if (v.length === 0) {
    issues.add(path, "Must not be empty.");
    return null;
  }
  if (v.length > maxLen) {
    issues.add(path, `Must be at most ${maxLen} characters.`);
    return null;
  }
  if (FORBIDDEN_KEYS.includes(v)) {
    issues.add(path, "This name is not allowed.");
    return null;
  }
  return v;
}

function checkRef(
  v: unknown,
  path: string,
  issues: Issues
): RecipeColumnRef | null {
  if (!isPlainObject(v)) {
    issues.add(path, "Must be an object.");
    return null;
  }
  checkKeys(v, path, ["table", "column"], [], issues);
  const table = checkName(getOwn(v, "table"), `${path}.table`, issues);
  const column = checkName(getOwn(v, "column"), `${path}.column`, issues);
  return table !== null && column !== null ? { table, column } : null;
}

function checkTables(v: unknown, issues: Issues): RecipeTable[] {
  const out: RecipeTable[] = [];
  if (!Array.isArray(v)) {
    issues.add("$.tables", "Must be an array.");
    return out;
  }
  if (v.length > RECIPE_MAX_TABLES) {
    issues.add("$.tables", `At most ${RECIPE_MAX_TABLES} tables are allowed.`);
    return out;
  }
  const seen = new Set<string>();
  v.forEach((t, i) => {
    const path = `$.tables[${i}]`;
    if (!isPlainObject(t)) {
      issues.add(path, "Must be an object.");
      return;
    }
    checkKeys(t, path, ["name", "columns"], [], issues);
    const name = checkName(getOwn(t, "name"), `${path}.name`, issues);
    if (name !== null) {
      if (seen.has(name)) issues.add(`${path}.name`, "Duplicate table name.");
      seen.add(name);
    }
    const cols = getOwn(t, "columns");
    const columns: { name: string; type: ColumnType }[] = [];
    if (!Array.isArray(cols)) {
      issues.add(`${path}.columns`, "Must be an array.");
    } else if (cols.length > RECIPE_MAX_COLUMNS_PER_TABLE) {
      issues.add(
        `${path}.columns`,
        `At most ${RECIPE_MAX_COLUMNS_PER_TABLE} columns are allowed.`
      );
    } else {
      const seenCols = new Set<string>();
      cols.forEach((c, j) => {
        const cpath = `${path}.columns[${j}]`;
        if (!isPlainObject(c)) {
          issues.add(cpath, "Must be an object.");
          return;
        }
        checkKeys(c, cpath, ["name", "type"], [], issues);
        const cname = checkName(getOwn(c, "name"), `${cpath}.name`, issues);
        const ctype = getOwn(c, "type");
        if (typeof ctype !== "string" || !COLUMN_TYPES.includes(ctype)) {
          issues.add(cpath + ".type", "Must be number, boolean, date, or string.");
        }
        if (cname !== null) {
          if (seenCols.has(cname)) {
            issues.add(`${cpath}.name`, "Duplicate column name.");
          }
          seenCols.add(cname);
          if (typeof ctype === "string" && COLUMN_TYPES.includes(ctype)) {
            columns.push({ name: cname, type: ctype as ColumnType });
          }
        }
      });
    }
    if (name !== null) out.push({ name, columns });
  });
  return out;
}

function checkConfidence(v: unknown, path: string, issues: Issues): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    issues.add(path, "Must be a number from 0 to 1.");
    return null;
  }
  return v;
}

function checkBool(v: unknown, path: string, issues: Issues): boolean | null {
  if (typeof v !== "boolean") {
    issues.add(path, "Must be true or false.");
    return null;
  }
  return v;
}

/**
 * Validate an already-parsed JSON value. Total: never throws.
 */
export function validateRecipeValue(value: unknown): ValidationResult {
  const issues = new Issues();
  try {
    return validateInner(value, issues);
  } catch {
    issues.add("$", "The recipe could not be checked.");
    return { ok: false, errors: issues.list };
  }
}

function validateInner(value: unknown, issues: Issues): ValidationResult {
  if (!isPlainObject(value)) {
    issues.add("$", "A recipe must be a JSON object.");
    return { ok: false, errors: issues.list };
  }
  checkKeys(
    value,
    "$",
    ["format", "version", "createdAt", "tables", "matches", "cleanings", "join"],
    [],
    issues
  );
  if (getOwn(value, "format") !== RECIPE_FORMAT) {
    issues.add("$.format", `Must be "${RECIPE_FORMAT}".`);
  }
  const version = getOwn(value, "version");
  if (version !== RECIPE_VERSION) {
    if (typeof version === "number" && version > RECIPE_VERSION) {
      issues.add(
        "$.version",
        `This recipe was made by a newer version (${version}). This app reads version ${RECIPE_VERSION}.`
      );
    } else {
      issues.add("$.version", `Must be ${RECIPE_VERSION}.`);
    }
  }
  const createdAt = getOwn(value, "createdAt");
  if (typeof createdAt !== "string" || !ISO_TIMESTAMP.test(createdAt)) {
    issues.add("$.createdAt", "Must be an ISO 8601 UTC timestamp.");
  }

  const tables = checkTables(getOwn(value, "tables"), issues);
  const columnsByTable = new Map<string, Map<string, ColumnType>>();
  for (const t of tables) {
    columnsByTable.set(t.name, new Map(t.columns.map((c) => [c.name, c.type])));
  }
  const refExists = (ref: RecipeColumnRef, path: string): boolean => {
    const cols = columnsByTable.get(ref.table);
    if (!cols) {
      issues.add(`${path}.table`, "This table is not described in tables.");
      return false;
    }
    if (!cols.has(ref.column)) {
      issues.add(`${path}.column`, "This column is not in the table description.");
      return false;
    }
    return true;
  };

  const rawMatches = getOwn(value, "matches");
  const rawCleanings = getOwn(value, "cleanings");
  const matches: RecipeMatch[] = [];
  const cleanings: RecipeCleaning[] = [];
  const matchCount = Array.isArray(rawMatches) ? rawMatches.length : 0;
  const cleaningCount = Array.isArray(rawCleanings) ? rawCleanings.length : 0;
  if (matchCount + cleaningCount > RECIPE_MAX_ITEMS) {
    issues.add("$", `At most ${RECIPE_MAX_ITEMS} matches and cleanings are allowed.`);
  } else {
    if (!Array.isArray(rawMatches)) {
      issues.add("$.matches", "Must be an array.");
    } else {
      rawMatches.forEach((m, i) => {
        const path = `$.matches[${i}]`;
        if (!isPlainObject(m)) {
          issues.add(path, "Must be an object.");
          return;
        }
        checkKeys(m, path, ["left", "right", "confidence", "edited"], [], issues);
        const left = checkRef(getOwn(m, "left"), `${path}.left`, issues);
        const right = checkRef(getOwn(m, "right"), `${path}.right`, issues);
        const confidence = checkConfidence(
          getOwn(m, "confidence"),
          `${path}.confidence`,
          issues
        );
        const edited = checkBool(getOwn(m, "edited"), `${path}.edited`, issues);
        if (left && right && confidence !== null && edited !== null) {
          const okL = refExists(left, `${path}.left`);
          const okR = refExists(right, `${path}.right`);
          if (okL && okR) matches.push({ left, right, confidence, edited });
        }
      });
    }
    if (!Array.isArray(rawCleanings)) {
      issues.add("$.cleanings", "Must be an array.");
    } else {
      rawCleanings.forEach((c, i) => {
        const path = `$.cleanings[${i}]`;
        if (!isPlainObject(c)) {
          issues.add(path, "Must be an object.");
          return;
        }
        checkKeys(c, path, ["rule", "table"], ["column", "canonical", "edited"], issues);
        const rule = getOwn(c, "rule");
        if (typeof rule !== "string" || !RULES.includes(rule)) {
          issues.add(
            `${path}.rule`,
            "Must be whitespace, case, category, duplicate-rows, or outliers."
          );
          return;
        }
        const table = checkName(getOwn(c, "table"), `${path}.table`, issues);
        const hasColumn = Object.prototype.hasOwnProperty.call(c, "column");
        const out: RecipeCleaning = { rule: rule as RecipeRule, table: table ?? "" };
        let ok = table !== null;
        if (rule === "duplicate-rows") {
          if (hasColumn) {
            issues.add(`${path}.column`, "Not allowed for duplicate-rows.");
            ok = false;
          }
          if (table !== null && !columnsByTable.has(table)) {
            issues.add(`${path}.table`, "This table is not described in tables.");
            ok = false;
          }
        } else {
          const column = checkName(getOwn(c, "column"), `${path}.column`, issues);
          if (column === null) {
            ok = false;
          } else {
            out.column = column;
            if (table !== null && !refExists({ table, column }, path)) ok = false;
          }
        }
        const hasCanonical = Object.prototype.hasOwnProperty.call(c, "canonical");
        const hasEdited = Object.prototype.hasOwnProperty.call(c, "edited");
        if (rule === "category") {
          if (hasCanonical) {
            const canonical = checkName(
              getOwn(c, "canonical"),
              `${path}.canonical`,
              issues,
              RECIPE_MAX_VALUE_LENGTH
            );
            if (canonical === null) ok = false;
            else out.canonical = canonical;
          }
          if (hasEdited) {
            const edited = checkBool(getOwn(c, "edited"), `${path}.edited`, issues);
            if (edited === null) ok = false;
            else out.edited = edited;
          }
        } else {
          if (hasCanonical) {
            issues.add(`${path}.canonical`, "Only allowed for category.");
            ok = false;
          }
          if (hasEdited) {
            issues.add(`${path}.edited`, "Only allowed for category.");
            ok = false;
          }
        }
        if (ok) cleanings.push(out);
      });
    }
  }

  // join
  let join: { anchor: string; keys: RecipeJoinKey[] } = { anchor: "", keys: [] };
  const rawJoin = getOwn(value, "join");
  if (!isPlainObject(rawJoin)) {
    issues.add("$.join", "Must be an object.");
  } else {
    checkKeys(rawJoin, "$.join", ["anchor", "keys"], [], issues);
    const anchor = checkName(getOwn(rawJoin, "anchor"), "$.join.anchor", issues);
    if (anchor !== null && !columnsByTable.has(anchor)) {
      issues.add("$.join.anchor", "This table is not described in tables.");
    }
    const keys: RecipeJoinKey[] = [];
    const rawKeys = getOwn(rawJoin, "keys");
    if (!Array.isArray(rawKeys)) {
      issues.add("$.join.keys", "Must be an array.");
    } else if (rawKeys.length > RECIPE_MAX_ITEMS) {
      issues.add("$.join.keys", `At most ${RECIPE_MAX_ITEMS} keys are allowed.`);
    } else {
      const pairIds = new Set(matches.map((m) => unorderedPair(m.left, m.right)));
      rawKeys.forEach((k, i) => {
        const path = `$.join.keys[${i}]`;
        if (!isPlainObject(k)) {
          issues.add(path, "Must be an object.");
          return;
        }
        checkKeys(k, path, ["left", "right"], [], issues);
        const left = checkRef(getOwn(k, "left"), `${path}.left`, issues);
        const right = checkRef(getOwn(k, "right"), `${path}.right`, issues);
        if (left && right) {
          const okL = refExists(left, `${path}.left`);
          const okR = refExists(right, `${path}.right`);
          if (okL && okR) {
            if (!pairIds.has(unorderedPair(left, right))) {
              issues.add(path, "A join key must be one of the listed matches.");
            } else {
              keys.push({ left, right });
            }
          }
        }
      });
    }
    if (anchor !== null) join = { anchor, keys };
  }

  if (issues.list.length > 0) {
    return { ok: false, errors: issues.list };
  }
  const recipe: Recipe = {
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    createdAt: createdAt as string,
    tables,
    matches,
    cleanings,
    join,
  };
  return { ok: true, recipe };
}

function unorderedPair(a: RecipeColumnRef, b: RecipeColumnRef): string {
  const ka = JSON.stringify([a.table, a.column]);
  const kb = JSON.stringify([b.table, b.column]);
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * Validate recipe TEXT: size check first, then `JSON.parse`, then the schema.
 * Total: never throws.
 */
export function validateRecipeText(text: string): ValidationResult {
  try {
    if (typeof text !== "string") {
      return { ok: false, errors: [{ path: "$", message: "The recipe must be text." }] };
    }
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > RECIPE_MAX_BYTES) {
      return {
        ok: false,
        errors: [
          {
            path: "$",
            message: `The file is too large (${bytes} bytes). The limit is ${RECIPE_MAX_BYTES} bytes.`,
          },
        ],
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        errors: [{ path: "$", message: "The file is not valid JSON." }],
      };
    }
    return validateRecipeValue(parsed);
  } catch {
    return {
      ok: false,
      errors: [{ path: "$", message: "The recipe could not be checked." }],
    };
  }
}
