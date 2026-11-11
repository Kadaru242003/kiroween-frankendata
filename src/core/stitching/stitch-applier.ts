/**
 * StitchApplier — cleaned-copy creation (Feature 2, task 8.1).
 *
 * This module implements step 1 of the apply pipeline described in the design
 * ("Apply and Undo in DuckDB" → "Apply", bullet 1 "Cleaned copies"): for a
 * source table with at least one approved {@link CleaningProposal}, it creates a
 * NEW table named `stitch_<n>_clean_<name>` via explicit typed DDL and fills it
 * with transformed rows selected from the original. Originals are never mutated
 * (Req 4.1) — the only DML this module issues is `CREATE TABLE` / `INSERT …
 * SELECT` against the freshly-created `stitch_`-prefixed copy, reading from the
 * original read-only.
 *
 * The per-session apply counter / undo recording (task 8.3) and plan assembly
 * live elsewhere. This module exposes, for the cleaned-copy step (8.1):
 *
 *   - {@link cleanedCopyTableName} — the `stitch_<n>_clean_<name>` naming helper
 *     (so 8.3 can wire the counter `n`);
 *   - {@link buildCleanedCopySql} — a pure builder returning the exact DDL/DML
 *     strings for a cleaned copy (unit-testable without DuckDB);
 *   - {@link applyCleanedCopy} — executes that SQL via {@link DuckDBService} and
 *     returns the created table name.
 *
 * ...and for the join-chain step (8.2):
 *
 *   - {@link resultTableName} — the `stitch_<n>_result` naming helper;
 *   - {@link selectAnchorTable} — most-rows anchor selection with an override;
 *   - {@link buildJoinChainSql} — a pure builder returning the exact
 *     `CREATE TABLE stitch_<n>_result AS SELECT …` LEFT-JOIN chain
 *     (unit-testable without DuckDB);
 *   - {@link applyJoinChain} — executes that SQL via {@link DuckDBService},
 *     returning the created table name and the ordered list of columns.
 *
 * ## The join chain (design: "Apply" bullet 2, Req 7.1, 7.3–7.6, 7.8, 7.10)
 *
 * Starting from the anchor table (default = most rows, {@link selectAnchorTable},
 * Req 7.2), every remaining table is LEFT JOINed in **descending approved-match
 * confidence** order (Req 7.3). The join key for each joined table is the
 * highest-confidence approved {@link MatchProposal} connecting it to an
 * already-joined table (Req 7.4); its non-key approved matches are surfaced as
 * extra "same-meaning" columns, not join conditions (Req 7.5). Because the join
 * reads the cleaned copies produced by 8.1 (or the original when a table has no
 * approved cleaning), the keys are compared on their trimmed / case-normalized
 * post-cleaning values (Req 7.8). The matched key column appears once under the
 * anchor's column name (Req 7.6); any other output-name collision across source
 * tables is disambiguated by prefixing the source table name (Req 7.10). The
 * result is materialized as `stitch_<n>_result` via `CREATE TABLE … AS SELECT`.
 *
 * ## Escaping invariant (design: "Identifier and literal escaping", Property 13)
 *
 * EVERY table/column identifier emitted into SQL goes through {@link quoteIdent}
 * and EVERY string literal — user-edited `canonical` values, differing-casing
 * variants, category variant keys — goes through {@link quoteString}. There is
 * no raw concatenation of a name or value into SQL anywhere in this module, so
 * an adversarial table/column name or canonical value (`O'Brien`, `"Night"
 * Howler`, the word `SELECT`) stays a harmless data value.
 *
 * ## The transformations (design: "Apply" bullet 1 + "Cleaning rules")
 *
 * Per source column, a SELECT expression is composed from the approved
 * proposals targeting it, applied in a fixed order so repeated application is a
 * no-op (idempotent, Req 2.8):
 *
 *   1. **whitespace** (`whitespace-case` with no `variantMap`) → trim + collapse
 *      internal whitespace via `regexp_replace(trim(col), '\s+', ' ', 'g')`
 *      (matches {@link normalizeWhitespace}; never changes case).
 *   2. **case** (`whitespace-case` WITH a `variantMap`) → a `CASE` mapping each
 *      specific differing-casing variant to its canonical form (never a blanket
 *      upper/title-case).
 *   3. **category-standardize** → a `CASE` mapping each variant to the
 *      (possibly user-edited) `canonical` literal.
 *
 * When more than one of these targets the same column, the expressions are
 * nested in that order (whitespace innermost) so the column's final value is
 * the composed transform. A column with no approved cleaning is selected
 * verbatim (`"col"`), preserving its type.
 *
 * Row-level transforms:
 *
 *   - **outliers** (number column) → an extra `is_outlier BOOLEAN` column
 *     computed from the Tukey fences `[Q1 − 1.5·IQR, Q3 + 1.5·IQR]` evaluated in
 *     SQL over the FULL column with `quantile_cont` (the same fences task 7's
 *     counts use); no rows are removed (Req 2.6).
 *   - **duplicate-rows** → keep-first via
 *     `row_number() OVER (PARTITION BY <normalized value exprs> ORDER BY rowid) = 1`
 *     (Req 2.4); "first" is fixed by `rowid`, partitions use the same
 *     trim/collapse normalization used for detection.
 *
 * ## DuckDB-WASM MVP quirks (documented by task 7 in `cleaning-rules.ts`)
 *
 * The MVP bundle crashes on a literal NUL byte and on certain
 * `COUNT(DISTINCT expr)` / group-on-`regexp_replace` shapes. This module avoids
 * those: the dedupe uses a windowed `row_number()` (not grouping on normalized
 * keys), and the typed DDL + `INSERT … SELECT` form never needs a composite
 * `COUNT(DISTINCT …)`. Outlier fences are computed with the same CTE shape the
 * task-7 counts already run cleanly.
 */

import {
  COLUMN_TYPE_TO_DUCKDB_TYPE,
  type ColumnSchema,
  type ColumnType,
  type DuckDBService,
  type LoadedTable,
} from "../types";
import { quoteIdent, quoteString } from "./sql-escape";
import type {
  CleaningProposal,
  MatchProposal,
  StitchPlan,
  UndoStep,
} from "./types";

/** The `stitch_` prefix every applier-created table carries (Req 4.1). */
export const STITCH_TABLE_PREFIX = "stitch_";

/** The `is_outlier` column name added for approved outlier proposals (Req 2.6). */
export const IS_OUTLIER_COLUMN = "is_outlier";

/**
 * The name of the cleaned copy of a source table under apply counter `n`:
 * `stitch_<n>_clean_<name>` (design: "Table naming convention"). `name` is the
 * source table's existing (already-sanitized) DuckDB `tableName`, used verbatim
 * so undo can match it and `quoteIdent` keeps it safe in SQL regardless of its
 * characters. `n` must be a non-negative integer (the per-session counter wired
 * by task 8.3).
 */
export function cleanedCopyTableName(n: number, sourceTableName: string): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`apply counter must be a non-negative integer: ${n}`);
  }
  return `${STITCH_TABLE_PREFIX}${n}_clean_${sourceTableName}`;
}

/**
 * The SQL expression that trim+collapses whitespace for a text column, matching
 * {@link normalizeWhitespace} (`value.trim().replace(/\s+/gu, " ")`) and the
 * duplicate-key normalization in `cleaning-rules.ts`. Never changes case.
 */
function whitespaceExpr(innerExpr: string): string {
  return `regexp_replace(trim(${innerExpr}), '\\s+', ' ', 'g')`;
}

/**
 * Build a `CASE <inner> WHEN <variant> THEN <canonical> … ELSE <inner> END`
 * expression mapping each variant surface form to its canonical. Variants are
 * emitted in a fixed (lexicographic) order so the generated SQL is
 * deterministic; both the matched variant and the replacement go through
 * {@link quoteString}. An empty map returns `inner` unchanged.
 */
function caseMapExpr(
  innerExpr: string,
  variantMap: Record<string, string>
): string {
  const variants = Object.keys(variantMap).sort();
  if (variants.length === 0) {
    return innerExpr;
  }
  const whens = variants
    .map(
      (variant) =>
        `WHEN ${quoteString(variant)} THEN ${quoteString(variantMap[variant])}`
    )
    .join(" ");
  return `CASE ${innerExpr} ${whens} ELSE ${innerExpr} END`;
}

/**
 * Compose the SELECT expression for a single source column from the approved
 * proposals that target it, in the fixed order whitespace → case → category.
 * Returns `"col"` (verbatim) when nothing targets the column.
 */
function columnSelectExpr(
  column: ColumnSchema,
  proposalsForColumn: CleaningProposal[]
): string {
  let expr = quoteIdent(column.name);

  // 1. whitespace: a whitespace-case proposal WITHOUT a variantMap.
  const hasWhitespace = proposalsForColumn.some(
    (p) => p.kind === "whitespace-case" && !p.variantMap
  );
  if (hasWhitespace) {
    expr = whitespaceExpr(expr);
  }

  // 2. case: a whitespace-case proposal WITH a variantMap (differing casings).
  const caseProposal = proposalsForColumn.find(
    (p) => p.kind === "whitespace-case" && p.variantMap
  );
  if (caseProposal?.variantMap) {
    expr = caseMapExpr(expr, caseProposal.variantMap);
  }

  // 3. category-standardize: map each variant → its (possibly edited) canonical.
  const category = proposalsForColumn.find(
    (p) => p.kind === "category-standardize"
  );
  if (category?.variantMap) {
    expr = caseMapExpr(expr, category.variantMap);
  }

  return expr;
}

/**
 * The normalization expression used to PARTITION the keep-first dedupe, mirroring
 * the duplicate-key logic in `cleaning-rules.ts`: text columns are
 * trim+collapsed (so rows differing only by whitespace collapse into one
 * partition); non-text columns are cast to VARCHAR. NULLs are coalesced to a
 * printable sentinel so two NULLs partition together (a literal NUL byte crashes
 * the MVP bundle).
 */
function duplicatePartitionExpr(column: ColumnSchema): string {
  const ident = quoteIdent(column.name);
  const nullSentinel = quoteString("\u2400NULL\u2400");
  if (column.type === "string") {
    return `coalesce(${whitespaceExpr(ident)}, ${nullSentinel})`;
  }
  return `coalesce(CAST(${ident} AS VARCHAR), ${nullSentinel})`;
}

/** The DuckDB column type for the extra `is_outlier` flag column. */
const BOOLEAN_DUCKDB_TYPE = COLUMN_TYPE_TO_DUCKDB_TYPE.boolean;

/** Approved proposals grouped for a single source table. */
export interface ApprovedCleaning {
  /** whitespace-case / category-standardize proposals, keyed per column. */
  columnProposals: CleaningProposal[];
  /** at most one outlier proposal per column (number columns only). */
  outlierColumns: ColumnSchema[];
  /** true when a duplicate-rows proposal is approved for this table. */
  dedupe: boolean;
}

/**
 * The SQL strings that create and fill one cleaned copy. `columns` lists the
 * cleaned copy's columns in order (the source columns plus a trailing
 * `is_outlier` when any outlier proposal is approved) — used by callers (and
 * the descriptor builder in later tasks) without re-reading the schema.
 */
export interface CleanedCopySql {
  tableName: string;
  createSql: string;
  insertSql: string;
  columns: ColumnSchema[];
}

/**
 * Pure builder: produce the typed `CREATE TABLE` and the `INSERT … SELECT` that
 * materialize the cleaned copy `stitch_<n>_clean_<source>` from `source`.
 *
 * Deterministic and side-effect-free; {@link applyCleanedCopy} runs the result.
 * `approved` must contain only proposals that target this `source` table (the
 * caller filters by table); unknown-column proposals are ignored defensively.
 *
 * @param n          per-session apply counter (from task 8.3).
 * @param sourceTableName  the original table's DuckDB name (read-only source).
 * @param sourceSchema     the original table's columns, in order (types preserved).
 * @param approved         the approved cleanings for this table.
 */
export function buildCleanedCopySql(
  n: number,
  sourceTableName: string,
  sourceSchema: ColumnSchema[],
  approved: ApprovedCleaning
): CleanedCopySql {
  const tableName = cleanedCopyTableName(n, sourceTableName);
  const tableIdent = quoteIdent(tableName);
  const sourceIdent = quoteIdent(sourceTableName);

  // Map column name → the approved per-column proposals targeting it.
  const byColumn = new Map<string, CleaningProposal[]>();
  for (const proposal of approved.columnProposals) {
    const col = proposal.target.columnName;
    if (col === undefined) {
      continue;
    }
    const bucket = byColumn.get(col);
    if (bucket) {
      bucket.push(proposal);
    } else {
      byColumn.set(col, [proposal]);
    }
  }

  const outlierColumnNames = new Set(
    approved.outlierColumns.map((c) => c.name)
  );

  // Typed DDL: every source column keeps its original type (Req: types
  // preserved); an outlier approval appends an is_outlier BOOLEAN column.
  const columns: ColumnSchema[] = sourceSchema.map((c) => ({ ...c }));
  const columnDefs = columns.map(
    (col) => `${quoteIdent(col.name)} ${columnTypeSql(col.type)}`
  );
  if (outlierColumnNames.size > 0) {
    columns.push({ name: IS_OUTLIER_COLUMN, type: "boolean" });
    columnDefs.push(`${quoteIdent(IS_OUTLIER_COLUMN)} ${BOOLEAN_DUCKDB_TYPE}`);
  }
  const createSql = `CREATE TABLE ${tableIdent} (${columnDefs.join(", ")})`;

  // SELECT list: cleaned per-column expressions, then the is_outlier flag.
  const selectExprs = sourceSchema.map((col) =>
    columnSelectExpr(col, byColumn.get(col.name) ?? [])
  );
  if (outlierColumnNames.size > 0) {
    selectExprs.push(outlierFlagExpr(sourceSchema, outlierColumnNames));
  }

  const insertSql = buildInsertSql(
    tableIdent,
    sourceIdent,
    sourceSchema,
    selectExprs,
    approved.dedupe
  );

  return { tableName, createSql, insertSql, columns };
}

/** DuckDB type keyword for a {@link ColumnType}. */
function columnTypeSql(type: ColumnType): string {
  return COLUMN_TYPE_TO_DUCKDB_TYPE[type];
}

/**
 * The `is_outlier` boolean SELECT expression: TRUE when ANY approved number
 * column's value falls outside its own full-column Tukey fences. The fences are
 * computed per column in a `q` CTE referenced by the INSERT's FROM (see
 * {@link buildInsertSql}); here we only reference those CTE columns. A row is an
 * outlier if any flagged column is outside its fences (NULLs never flag).
 */
function outlierFlagExpr(
  sourceSchema: ColumnSchema[],
  outlierColumnNames: Set<string>
): string {
  const terms = sourceSchema
    .filter((c) => outlierColumnNames.has(c.name))
    .map((c) => {
      const col = quoteIdent(c.name);
      const q1 = quoteIdent(`__q1_${c.name}`);
      const q3 = quoteIdent(`__q3_${c.name}`);
      // col < q1 − 1.5·IQR OR col > q3 + 1.5·IQR, with IQR = q3 − q1.
      return (
        `(${col} IS NOT NULL AND (` +
        `${col} < q.${q1} - 1.5 * (q.${q3} - q.${q1}) OR ` +
        `${col} > q.${q3} + 1.5 * (q.${q3} - q.${q1})))`
      );
    });
  if (terms.length === 0) {
    return "FALSE";
  }
  return `(${terms.join(" OR ")})`;
}

/**
 * Compose the `INSERT INTO <copy> SELECT … FROM <source>[, q][ dedupe]`.
 *
 * - When outliers are flagged, a cross-joined `q` CTE supplies per-column
 *   `quantile_cont` quartiles (q1/q3) over the full source column.
 * - When dedupe is on, the SELECT is wrapped so only the first row per
 *   normalized partition survives (`row_number() … = 1`).
 */
function buildInsertSql(
  tableIdent: string,
  sourceIdent: string,
  sourceSchema: ColumnSchema[],
  selectExprs: string[],
  dedupe: boolean
): string {
  // The outlier flag references the quartile CTE via `q."__q1_…"` / `q."__q3_…"`.
  const usesQ = selectExprs.some((e) => /q\."__q[13]_/.test(e));
  // `WITH q AS (…) ` prefix when the outlier flag needs quartiles; the `q`
  // relation is cross-joined into the FROM so every row sees the fences.
  const ctePrefix = usesQ
    ? `${quartileCte(sourceIdent, sourceSchema, selectExprs)} `
    : "";
  const fromRel = usesQ ? `${sourceIdent}, q` : sourceIdent;

  const projection = selectExprs.join(", ");

  if (!dedupe) {
    return `INSERT INTO ${tableIdent} ${ctePrefix}SELECT ${projection} FROM ${fromRel}`;
  }

  // Dedupe: keep-first per normalized partition, ordered by rowid. The inner
  // query computes every cleaned column (aliased c0…cN so the outer query can
  // project them by name without re-referencing the source or the `q` CTE) plus
  // the window rank; the outer query keeps the first row of each partition.
  const partitionExprs = sourceSchema
    .map((c) => duplicatePartitionExpr(c))
    .join(", ");
  const windowed =
    `row_number() OVER (PARTITION BY ${partitionExprs} ORDER BY rowid) AS __rn`;
  const aliasedInner = selectExprs
    .map((expr, i) => `${expr} AS ${quoteIdent(`c${i}`)}`)
    .join(", ");
  const outerProjection = selectExprs
    .map((_, i) => quoteIdent(`c${i}`))
    .join(", ");

  return (
    `INSERT INTO ${tableIdent} SELECT ${outerProjection} FROM (` +
    `${ctePrefix}SELECT ${aliasedInner}, ${windowed} FROM ${fromRel}` +
    `) WHERE __rn = 1`
  );
}

/**
 * The `WITH q AS (SELECT quantile_cont(col,0.25) AS "__q1_col", … )` CTE that
 * supplies per-column quartiles for the outlier flag, over non-null values of
 * each flagged source column. The CTE aliases are the `__q1_<name>` / `__q3_<name>`
 * identifiers the {@link outlierFlagExpr} references.
 */
function quartileCte(
  sourceIdent: string,
  sourceSchema: ColumnSchema[],
  selectExprs: string[]
): string {
  const flagged = sourceSchema.filter((c) =>
    selectExprs.some((e) =>
      e.includes(`q.${quoteIdent(`__q1_${c.name}`)}`)
    )
  );
  const parts: string[] = [];
  for (const c of flagged) {
    const col = quoteIdent(c.name);
    const q1 = quoteIdent(`__q1_${c.name}`);
    const q3 = quoteIdent(`__q3_${c.name}`);
    parts.push(
      `quantile_cont(${col}, 0.25) AS ${q1}`,
      `quantile_cont(${col}, 0.75) AS ${q3}`
    );
  }
  return `WITH q AS (SELECT ${parts.join(", ")} FROM ${sourceIdent})`;
}

/**
 * Execute the cleaned-copy DDL/DML for one source table against DuckDB and
 * return the created table name (`stitch_<n>_clean_<source>`). Reads the source
 * read-only; the only writes are to the new copy. Caller records the returned
 * name in the {@link import("./types").UndoStep} (task 8.3).
 */
export async function applyCleanedCopy(
  db: DuckDBService,
  n: number,
  sourceTableName: string,
  sourceSchema: ColumnSchema[],
  approved: ApprovedCleaning
): Promise<string> {
  const { tableName, createSql, insertSql } = buildCleanedCopySql(
    n,
    sourceTableName,
    sourceSchema,
    approved
  );
  await db.query(createSql);
  await db.query(insertSql);
  return tableName;
}

/**
 * Split the approved {@link CleaningProposal}s targeting one source table into
 * the {@link ApprovedCleaning} shape {@link buildCleanedCopySql} consumes.
 * Outlier proposals are matched to their source {@link ColumnSchema} (so the
 * builder knows the column's type); duplicate-rows sets the `dedupe` flag;
 * everything else is a per-column transform.
 */
export function groupApprovedForTable(
  sourceSchema: ColumnSchema[],
  approved: CleaningProposal[]
): ApprovedCleaning {
  const byName = new Map(sourceSchema.map((c) => [c.name, c]));
  const columnProposals: CleaningProposal[] = [];
  const outlierColumns: ColumnSchema[] = [];
  const seenOutlier = new Set<string>();
  let dedupe = false;

  for (const proposal of approved) {
    switch (proposal.kind) {
      case "duplicate-rows":
        dedupe = true;
        break;
      case "outliers": {
        const col = proposal.target.columnName;
        const schema = col ? byName.get(col) : undefined;
        if (schema && schema.type === "number" && !seenOutlier.has(col!)) {
          outlierColumns.push(schema);
          seenOutlier.add(col!);
        }
        break;
      }
      case "whitespace-case":
      case "category-standardize":
        if (proposal.target.columnName && byName.has(proposal.target.columnName)) {
          columnProposals.push(proposal);
        }
        break;
    }
  }

  return { columnProposals, outlierColumns, dedupe };
}
// ────────────────────────────────────────────────────────────────────────────
// Join chain (task 8.2) — design: "Apply" bullet 2, Req 7.1, 7.3–7.6, 7.8, 7.10
// ────────────────────────────────────────────────────────────────────────────

/**
 * The joined-result table name under apply counter `n`: `stitch_<n>_result`
 * (design: "Table naming convention"). `n` must be a non-negative integer (the
 * per-session counter wired by task 8.3).
 */
export function resultTableName(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`apply counter must be a non-negative integer: ${n}`);
  }
  return `${STITCH_TABLE_PREFIX}${n}_result`;
}

/**
 * One source table participating in the join chain. The join reads from
 * {@link readTableName} — the cleaned copy `stitch_<n>_clean_<name>` when the
 * table had approved cleaning (so keys compare post-cleaning, Req 7.8), or the
 * original table otherwise. {@link tableName} is the *logical* LoadedTable name
 * used by {@link MatchProposal} refs (`ColumnRef.tableName`); it is how matches
 * and the anchor override address a table, independent of which physical copy
 * is actually read. {@link schema} is the (possibly cleaned) output schema in
 * column order; a cleaned copy with an approved outlier proposal carries the
 * extra {@link IS_OUTLIER_COLUMN} column, which is projected like any other.
 */
export interface JoinTableInput {
  /** Logical LoadedTable name — matches `MatchProposal` `ColumnRef.tableName`. */
  tableName: string;
  /** Physical DuckDB table to read from (cleaned copy or original). */
  readTableName: string;
  /** Output columns, in order (post-cleaning if a cleaned copy is read). */
  schema: ColumnSchema[];
  /** Row count of this table (drives default anchor selection, Req 7.2). */
  rowCount: number;
}

/**
 * Pick the anchor table (design: "Apply" bullet 2, Req 7.2). The default anchor
 * is the table with the most rows; ties are broken by logical `tableName`
 * ascending so selection is deterministic. An optional `override` logical table
 * name wins when it names one of the `tables` (the UI's "change anchor", Req
 * 7.2); an override that matches no table is ignored and the default applies.
 *
 * @throws {RangeError} when `tables` is empty.
 */
export function selectAnchorTable(
  tables: JoinTableInput[],
  override?: string
): JoinTableInput {
  if (tables.length === 0) {
    throw new RangeError("join chain requires at least one table");
  }
  if (override !== undefined) {
    const chosen = tables.find((t) => t.tableName === override);
    if (chosen) {
      return chosen;
    }
  }
  // Most rows wins; ties broken by logical table name ascending (deterministic).
  return tables.reduce((best, t) => {
    if (t.rowCount > best.rowCount) {
      return t;
    }
    if (t.rowCount === best.rowCount && t.tableName < best.tableName) {
      return t;
    }
    return best;
  });
}

/** A column emitted into the result's SELECT list. */
export interface JoinResultColumn {
  /** The output column name (collision-prefixed per Req 7.10 when needed). */
  name: string;
  /** The logical source table this column came from. */
  sourceTableName: string;
  /** The source column name within that table. */
  sourceColumnName: string;
  /** The inferred output type (preserved from the source column). */
  type: ColumnType;
}

/** One table's placement in the LEFT JOIN chain, after ordering. */
export interface JoinStep {
  /** The table being LEFT JOINed in (anchor has no step). */
  table: JoinTableInput;
  /** The approved match used as this pair's join key (Req 7.4). */
  keyMatch: MatchProposal;
  /**
   * The already-joined side of the key: its logical table + column. The key
   * column appears once under THIS name (Req 7.6 — the anchor-side name for the
   * anchor-adjacent join), and the joined table's own key column is omitted.
   */
  leftTableName: string;
  leftColumnName: string;
  /** The joined table's key column (omitted from the projection, Req 7.6). */
  rightColumnName: string;
  /** Approved non-key matches carried as same-meaning columns (Req 7.5). */
  sameMeaningMatches: MatchProposal[];
}

/** The pure result of planning a join chain (ordering, keys, projection). */
export interface JoinChainPlan {
  tableName: string;
  anchor: JoinTableInput;
  steps: JoinStep[];
  columns: JoinResultColumn[];
}

/** The SQL that materializes the joined result, plus its output columns. */
export interface JoinChainSql {
  tableName: string;
  createSql: string;
  columns: JoinResultColumn[];
  /** The ordered logical table names in the chain (anchor first). */
  joinOrder: string[];
}

/** The two logical tables a match connects. */
function matchEndpoints(m: MatchProposal): [string, string] {
  return [m.left.tableName, m.right.tableName];
}

/**
 * Does this approved match connect `tableName` to any already-joined table?
 * Returns the (left=already-joined, right=new) endpoints oriented so `right`
 * belongs to `tableName`, or `null` when the match does not bridge the frontier.
 */
function orientMatch(
  m: MatchProposal,
  newTable: string,
  joined: Set<string>
): { leftTableName: string; leftColumnName: string; rightColumnName: string } | null {
  const [lt, rt] = matchEndpoints(m);
  if (lt === newTable && joined.has(rt)) {
    return {
      leftTableName: rt,
      leftColumnName: m.right.columnName,
      rightColumnName: m.left.columnName,
    };
  }
  if (rt === newTable && joined.has(lt)) {
    return {
      leftTableName: lt,
      leftColumnName: m.left.columnName,
      rightColumnName: m.right.columnName,
    };
  }
  return null;
}

/**
 * Plan the join chain deterministically (no SQL yet): choose the anchor, order
 * the remaining tables by descending approved-match confidence, pick each
 * pair's key match (highest-confidence approved match bridging the frontier,
 * Req 7.3/7.4), classify the remaining approved matches per joined table as
 * same-meaning columns (Req 7.5), and compute the collision-prefixed output
 * column list (Req 7.6, 7.10).
 *
 * Tables that never connect to the growing join frontier through an approved
 * match are left out of the chain (they have no join key); their columns do not
 * appear in the result. The anchor is always included even with zero matches.
 *
 * @param n            apply counter (for the result name).
 * @param tables       every participating table (anchor + candidates).
 * @param approvedMatches  the user-approved matches (any confidence).
 * @param anchorOverride   optional logical anchor table name (Req 7.2).
 */
export function planJoinChain(
  n: number,
  tables: JoinTableInput[],
  approvedMatches: MatchProposal[],
  anchorOverride?: string
): JoinChainPlan {
  const tableName = resultTableName(n);
  const anchor = selectAnchorTable(tables, anchorOverride);
  const byName = new Map(tables.map((t) => [t.tableName, t]));

  // Matches sorted by descending confidence, then stable id — the order Req 7.3
  // ("descending approved-match confidence") selects both the next table to
  // join and its key.
  const sortedMatches = [...approvedMatches].sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const joined = new Set<string>([anchor.tableName]);
  const steps: JoinStep[] = [];
  // Track which match became a key for a given joined table so the rest can be
  // classified as same-meaning columns for that table.
  const keyMatchByTable = new Map<string, MatchProposal>();

  // Grow the frontier: repeatedly take the highest-confidence approved match
  // that bridges an un-joined table to the already-joined set.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const m of sortedMatches) {
      const [lt, rt] = matchEndpoints(m);
      const newTable =
        !joined.has(lt) && joined.has(rt)
          ? lt
          : !joined.has(rt) && joined.has(lt)
            ? rt
            : null;
      if (newTable === null || !byName.has(newTable)) {
        continue;
      }
      const oriented = orientMatch(m, newTable, joined);
      if (oriented === null) {
        continue;
      }
      steps.push({
        table: byName.get(newTable)!,
        keyMatch: m,
        leftTableName: oriented.leftTableName,
        leftColumnName: oriented.leftColumnName,
        rightColumnName: oriented.rightColumnName,
        sameMeaningMatches: [],
      });
      keyMatchByTable.set(newTable, m);
      joined.add(newTable);
      progressed = true;
      break; // re-scan from the top so keys stay highest-confidence-first.
    }
  }

  // Same-meaning columns (Req 7.5): any approved match, both of whose tables are
  // in the chain, that is NOT a join key, carries its "new table" endpoint as an
  // extra column on that table's step. Each such match is attributed once, to
  // the table joined later (so the column lives on a table actually in the
  // chain). Deterministic: sortedMatches order.
  const stepByTable = new Map(steps.map((s) => [s.table.tableName, s]));
  const keyMatchIds = new Set(steps.map((s) => s.keyMatch.id));
  for (const m of sortedMatches) {
    if (keyMatchIds.has(m.id)) {
      continue;
    }
    const [lt, rt] = matchEndpoints(m);
    if (!joined.has(lt) || !joined.has(rt)) {
      continue; // at least one endpoint never joined.
    }
    // Attribute to whichever endpoint is NOT the anchor and has a step; prefer
    // the later-joined table. Both-non-anchor → the one with a step.
    const candidate =
      lt !== anchor.tableName && stepByTable.has(lt)
        ? lt
        : rt !== anchor.tableName && stepByTable.has(rt)
          ? rt
          : null;
    if (candidate !== null) {
      stepByTable.get(candidate)!.sameMeaningMatches.push(m);
    }
  }

  const columns = planResultColumns(anchor, steps);
  return { tableName, anchor, steps, columns };
}

/**
 * Build the ordered, collision-resolved output column list (Req 7.6, 7.10).
 *
 * Every anchor column is emitted. For each joined table, every column is emitted
 * EXCEPT its key column (which is represented once by the already-joined side,
 * Req 7.6). A would-be output name that collides with a name already emitted
 * from a different source table is prefixed with its source table name
 * (`<table>_<column>`, Req 7.10); if the prefixed form still collides it is
 * suffixed with an incrementing counter so output names stay unique.
 */
function planResultColumns(
  anchor: JoinTableInput,
  steps: JoinStep[]
): JoinResultColumn[] {
  const columns: JoinResultColumn[] = [];
  const used = new Set<string>();

  const emit = (
    sourceTableName: string,
    sourceColumnName: string,
    type: ColumnType
  ): void => {
    let name = sourceColumnName;
    if (used.has(name)) {
      // Req 7.10: disambiguate by prefixing the source table name.
      name = `${sourceTableName}_${sourceColumnName}`;
      let suffix = 2;
      while (used.has(name)) {
        name = `${sourceTableName}_${sourceColumnName}_${suffix}`;
        suffix += 1;
      }
    }
    used.add(name);
    columns.push({ name, sourceTableName, sourceColumnName, type });
  };

  for (const col of anchor.schema) {
    emit(anchor.tableName, col.name, col.type);
  }
  for (const step of steps) {
    for (const col of step.table.schema) {
      if (col.name === step.rightColumnName) {
        continue; // key column folded into the already-joined side (Req 7.6).
      }
      emit(step.table.tableName, col.name, col.type);
    }
  }
  return columns;
}

/**
 * Pure builder: produce the `CREATE TABLE stitch_<n>_result AS SELECT …` that
 * LEFT JOINs the chain (design: "Apply" bullet 2). Reads each table from its
 * {@link JoinTableInput.readTableName} (cleaned copy or original) so keys are
 * compared post-cleaning (Req 7.8). Deterministic and side-effect-free;
 * {@link applyJoinChain} runs the result.
 *
 * Every identifier is emitted through {@link quoteIdent}; the builder never
 * interpolates a raw name. Each table is aliased by its logical name so
 * same-named columns across tables are addressed unambiguously.
 */
export function buildJoinChainSql(
  n: number,
  tables: JoinTableInput[],
  approvedMatches: MatchProposal[],
  anchorOverride?: string
): JoinChainSql {
  const plan = planJoinChain(n, tables, approvedMatches, anchorOverride);
  const { anchor, steps, columns, tableName } = plan;

  const alias = (logical: string): string => quoteIdent(logical);

  // SELECT list: each planned column as `<alias>."<sourceCol>" AS "<outName>"`.
  const selectList = columns
    .map(
      (c) =>
        `${alias(c.sourceTableName)}.${quoteIdent(c.sourceColumnName)} AS ${quoteIdent(c.name)}`
    )
    .join(", ");

  // FROM anchor aliased by its logical name.
  let fromClause = `${quoteIdent(anchor.readTableName)} AS ${alias(anchor.tableName)}`;
  for (const step of steps) {
    // LEFT JOIN each table on its key, compared on the post-cleaning columns of
    // both sides (both are read from cleaned copies / originals, Req 7.8).
    const onClause =
      `${alias(step.leftTableName)}.${quoteIdent(step.leftColumnName)} = ` +
      `${alias(step.table.tableName)}.${quoteIdent(step.rightColumnName)}`;
    fromClause +=
      ` LEFT JOIN ${quoteIdent(step.table.readTableName)} AS ${alias(step.table.tableName)}` +
      ` ON ${onClause}`;
  }

  const createSql =
    `CREATE TABLE ${quoteIdent(tableName)} AS SELECT ${selectList} FROM ${fromClause}`;

  const joinOrder = [anchor.tableName, ...steps.map((s) => s.table.tableName)];
  return { tableName, createSql, columns, joinOrder };
}

/** The outcome of executing the join chain, for 8.3 to record / report. */
export interface AppliedJoinChain {
  /** The created result table name (`stitch_<n>_result`). */
  tableName: string;
  /** The result's output columns, in order. */
  columns: JoinResultColumn[];
  /** The ordered logical table names in the chain (anchor first). */
  joinOrder: string[];
}

/**
 * Execute the join-chain DDL against DuckDB and return the created result table
 * name plus its ordered columns. The only write is the `CREATE TABLE
 * stitch_<n>_result AS SELECT …`; every participating table is read read-only.
 * Task 8.3 records {@link AppliedJoinChain.tableName} in the
 * {@link import("./types").UndoStep} and computes the anchor-vs-result row
 * counts (many-to-many fan-out warning, Req 7.9) from the created table.
 */
export async function applyJoinChain(
  db: DuckDBService,
  n: number,
  tables: JoinTableInput[],
  approvedMatches: MatchProposal[],
  anchorOverride?: string
): Promise<AppliedJoinChain> {
  const { tableName, createSql, columns, joinOrder } = buildJoinChainSql(
    n,
    tables,
    approvedMatches,
    anchorOverride
  );
  await db.query(createSql);
  return { tableName, columns, joinOrder };
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level StitchApplier (task 8.3) — design: "Table naming convention",
// "Apply", "Undo"; Req 4.1, 4.2, 4.3, 4.4, 7.9, 7.12.
//
// This section wires the cleaned-copy step (8.1, {@link applyCleanedCopy}) and
// the join-chain step (8.2, {@link applyJoinChain}) into one cohesive apply
// operation behind a small session-scoped factory, {@link createStitchApplier}.
// It owns the three concerns 8.1/8.2 deliberately left out:
//
//   1. **Per-session apply counter `n`** — a monotonically increasing integer
//      (starts at 1, increments on every {@link StitchApplier.apply}, never
//      reused within a session). `n` is threaded into EVERY created table name —
//      both `stitch_<n>_clean_<name>` and `stitch_<n>_result` — so re-applying
//      while an earlier stitch is still live produces a disjoint set of
//      identifiers and never collides (design: "Table naming convention").
//   2. **Undo recording** — each apply records an {@link UndoStep} capturing
//      EXACTLY the tables it created, in creation order (Req 4.2); the most
//      recent step is "pending". {@link StitchApplier.undo} drops exactly those
//      tables (`DROP TABLE IF EXISTS`) and nothing else (Req 4.3), leaving the
//      un-prefixed originals provably untouched (Req 7.12, Req 4.1). Every
//      operation is in-memory DuckDB, no network (Req 4.4).
//   3. **Many-to-many fan-out reporting** — after materializing the result, the
//      anchor row count and the result row count are read back and returned so
//      the UI can warn and offer cancel when the join fans out (Req 7.9). The
//      applier itself never blocks: it reports counts; cancelling (dropping the
//      just-created tables) is the UI calling {@link StitchApplier.undo}.
// ────────────────────────────────────────────────────────────────────────────

/** The per-session apply counter's starting value (first apply is `n = 1`). */
export const FIRST_APPLY_COUNTER = 1;

/**
 * The anchor-vs-result row counts for the many-to-many fan-out warning (Req
 * 7.9). `fannedOut` is `true` when the LEFT JOIN chain produced MORE rows than
 * the anchor table (a many-to-many correspondence multiplied anchor rows); the
 * UI uses it to decide whether to surface the warning and offer a cancel.
 */
export interface FanOutCounts {
  /** The anchor table's row count BEFORE the join. */
  anchorRowCount: number;
  /** The joined result's row count AFTER the join. */
  resultRowCount: number;
  /** `true` when `resultRowCount > anchorRowCount` (a fan-out occurred). */
  fannedOut: boolean;
}

/**
 * The outcome of a single {@link StitchApplier.apply}: the created result table
 * name and its ordered output columns, the fan-out counts (Req 7.9), and the
 * {@link UndoStep} recorded for this apply (Req 4.2). `createdTableNames` on the
 * undo step lists every table the apply created — the cleaned copies first (in
 * the order their source tables appear in the plan) then the single result —
 * which is exactly the set {@link StitchApplier.undo} will drop (Req 4.3).
 */
export interface StitchApplyResult {
  /** The created result table (`stitch_<n>_result`). */
  resultTableName: string;
  /** The result's output columns, in order (collision-resolved per Req 7.10). */
  columns: JoinResultColumn[];
  /** The ordered logical table names in the join chain (anchor first). */
  joinOrder: string[];
  /** Anchor-vs-result counts for the fan-out warning (Req 7.9). */
  fanOut: FanOutCounts;
  /** The undo step recorded for this apply (Req 4.2). */
  undoStep: UndoStep;
  /** The apply counter used for this apply's table names. */
  counter: number;
}

/**
 * The session-scoped apply/undo surface. One instance per session owns the
 * monotonic apply counter and the pending {@link UndoStep}. Framework-agnostic:
 * it touches only the injected {@link DuckDBService} and in-memory state, with
 * no React/DOM/network (Req 4.4).
 */
export interface StitchApplier {
  /**
   * Apply a {@link StitchPlan}: create the cleaned copies + joined result under
   * a fresh apply counter, record the {@link UndoStep}, and return the result
   * descriptor including the fan-out counts (Req 7.9). The participating
   * `tables` are the current {@link LoadedTable}s (anchor + candidates); the
   * applier reads their schema/row counts and never mutates them (Req 7.12).
   */
  apply(plan: StitchPlan, tables: LoadedTable[]): Promise<StitchApplyResult>;
  /**
   * Drop exactly the tables created by the most recent not-yet-undone apply
   * (Req 4.3) and clear the pending step. A no-op when nothing is pending.
   * Returns the dropped table names (empty when nothing was pending).
   */
  undo(): Promise<string[]>;
  /** The pending undo step, or `null` when there is nothing to undo. */
  pendingUndo(): UndoStep | null;
  /** The next apply counter that will be used (for inspection/testing). */
  nextCounter(): number;
}

/**
 * Split a plan's approved cleanings by their target logical table name so each
 * source table's cleaned copy is built from only the proposals that target it.
 */
function cleaningsByTable(
  approvedCleanings: StitchPlan["approvedCleanings"]
): Map<string, CleaningProposal[]> {
  const byTable = new Map<string, CleaningProposal[]>();
  for (const proposal of approvedCleanings) {
    const table = proposal.target.tableName;
    const bucket = byTable.get(table);
    if (bucket) {
      bucket.push(proposal);
    } else {
      byTable.set(table, [proposal]);
    }
  }
  return byTable;
}

/**
 * Create a session-scoped {@link StitchApplier} over the given
 * {@link DuckDBService}. The returned applier owns a private, monotonically
 * increasing apply counter (starts at {@link FIRST_APPLY_COUNTER} = 1) and the
 * pending {@link UndoStep}; both are per-instance session state with no
 * persistence (Req 4.4).
 *
 * Apply pipeline (design: "Apply"):
 *   1. increment the counter to the fresh `n`;
 *   2. for each plan table WITH approved cleanings, create the cleaned copy
 *      `stitch_<n>_clean_<name>` ({@link applyCleanedCopy}); tables with no
 *      approved cleaning are read directly from their original (read-only);
 *   3. LEFT JOIN the chain into `stitch_<n>_result` ({@link applyJoinChain}),
 *      reading each table from its cleaned copy or original so keys compare
 *      post-cleaning (Req 7.8);
 *   4. record an {@link UndoStep} capturing EXACTLY the created tables, cleaned
 *      copies first (plan order) then the result (Req 4.2);
 *   5. read the anchor-vs-result row counts for the fan-out warning (Req 7.9).
 *
 * Every created table carries the apply counter `n` (both copies and result),
 * so re-applying before an undo yields a disjoint identifier set that never
 * collides with a prior live apply (design: "Table naming convention").
 */
export function createStitchApplier(db: DuckDBService): StitchApplier {
  // Per-session monotonic counter: the NEXT apply uses `counter`, then it is
  // bumped. Starts at FIRST_APPLY_COUNTER so the first apply is n = 1.
  let counter = FIRST_APPLY_COUNTER;
  // The most recent not-yet-undone apply's undo step (null when nothing pending).
  let pending: UndoStep | null = null;

  async function apply(
    plan: StitchPlan,
    tables: LoadedTable[]
  ): Promise<StitchApplyResult> {
    if (tables.length === 0) {
      throw new RangeError("apply requires at least one loaded table");
    }
    // 1. Claim a fresh counter for this apply. Claimed up front (before any DDL)
    //    so it is never reused even if a later step throws.
    const n = counter;
    counter += 1;

    const byTableCleanings = cleaningsByTable(plan.approvedCleanings);

    // 2. Build cleaned copies for tables that have at least one approved
    //    cleaning; others read their original. Record every created name in
    //    creation order so the UndoStep captures EXACTLY what was created.
    const createdTableNames: string[] = [];
    const joinInputs: JoinTableInput[] = [];

    for (const table of tables) {
      const approved = byTableCleanings.get(table.tableName) ?? [];
      if (approved.length > 0) {
        const grouped = groupApprovedForTable(table.schema, approved);
        const cleanedName = await applyCleanedCopy(
          db,
          n,
          table.tableName,
          table.schema,
          grouped
        );
        createdTableNames.push(cleanedName);
        // The cleaned copy's output schema (source columns + optional
        // is_outlier) drives the join projection.
        const { columns } = buildCleanedCopySql(
          n,
          table.tableName,
          table.schema,
          grouped
        );
        joinInputs.push({
          tableName: table.tableName,
          readTableName: cleanedName,
          schema: columns,
          rowCount: table.rowCount,
        });
      } else {
        joinInputs.push({
          tableName: table.tableName,
          readTableName: table.tableName,
          schema: table.schema,
          rowCount: table.rowCount,
        });
      }
    }

    // 3. Materialize the joined result reading the copies/originals (Req 7.8).
    const joined = await applyJoinChain(
      db,
      n,
      joinInputs,
      plan.approvedMatches,
      plan.anchorTableName
    );
    createdTableNames.push(joined.tableName);

    // 4. Record the undo step capturing exactly the created tables (Req 4.2).
    const undoStep: UndoStep = { createdTableNames };
    pending = undoStep;

    // 5. Fan-out counts (Req 7.9): the anchor row count before vs. the result
    //    row count after. The anchor is the first logical table in joinOrder.
    //    The "before" count MUST be the row count of the table the LEFT JOIN
    //    actually READS — the cleaned anchor copy (`stitch_<n>_clean_<anchor>`)
    //    when the anchor had approved cleanings, or the original otherwise —
    //    not the pre-cleaning `LoadedTable.rowCount`. A cleaning such as an
    //    approved duplicate-rows dedupe can SHRINK the anchor, so reading back
    //    the cleaned-input row count via `getRowCount(readTableName)` keeps
    //    `fannedOut` an honest comparison against the rows that fed the join.
    const anchorTableName = joined.joinOrder[0];
    const anchor = joinInputs.find((t) => t.tableName === anchorTableName);
    const anchorRowCount = anchor
      ? await db.getRowCount(anchor.readTableName)
      : 0;
    const resultRowCount = await db.getRowCount(joined.tableName);
    const fanOut: FanOutCounts = {
      anchorRowCount,
      resultRowCount,
      fannedOut: resultRowCount > anchorRowCount,
    };

    return {
      resultTableName: joined.tableName,
      columns: joined.columns,
      joinOrder: joined.joinOrder,
      fanOut,
      undoStep,
      counter: n,
    };
  }

  async function undo(): Promise<string[]> {
    if (pending === null) {
      return [];
    }
    const dropped = pending.createdTableNames;
    // Drop exactly the recorded tables and nothing else (Req 4.3). Every name
    // carries the stitch_ prefix (the applier never created an un-prefixed
    // table), so originals are provably untouched (Req 7.12, Req 4.1).
    for (const name of dropped) {
      await db.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
    }
    pending = null;
    return dropped;
  }

  return {
    apply,
    undo,
    pendingUndo: () => pending,
    nextCounter: () => counter,
  };
}
