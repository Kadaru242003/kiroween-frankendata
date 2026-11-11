/// <reference types="vite/client" />
/**
 * DuckDBService — the single in-memory DuckDB-WASM instance that owns typed
 * table creation, row insertion, string fallback, and preview/count queries
 * for the FrankenData file-intake pipeline (task 10.1).
 *
 * ## Responsibilities (design.md, "DuckDB-WASM Integration")
 *
 *   - Create exactly one in-memory DuckDB instance with **no persistent
 *     backing store** (Req 8.1, 11.2). The database path is `:memory:`; nothing
 *     is written to IndexedDB/OPFS or any file on disk.
 *   - `createTable` issues an explicit `CREATE TABLE "name" (col TYPE, …)` using
 *     the inferred {@link ColumnSchema} — never `CREATE TABLE … AS SELECT`
 *     auto-typing (Req 6.5). Each `ColumnType` maps to a DuckDB type via
 *     {@link COLUMN_TYPE_TO_DUCKDB_TYPE}.
 *   - Rows are inserted with every cell coerced to the column's DuckDB type
 *     (Req 6.6): `null`/NullToken → `NULL`, numeric strings → `DOUBLE`, boolean
 *     literals → `BOOLEAN`, date strings normalized to ISO `YYYY-MM-DD` →
 *     `DATE`, everything else → `VARCHAR`. The inserted row count is asserted to
 *     equal the parsed data row count.
 *   - **String fallback** (Req 6.7): if a column's values cannot be coerced to
 *     its inferred DuckDB type, that column is recreated/loaded as `VARCHAR` and
 *     the file still loads. The returned {@link LoadedTable}'s schema reflects
 *     the types actually used (a fallback column becomes `"string"`).
 *   - Any other failure produces an {@link IntakeError} (`table-load-failed`)
 *     naming the file and the failure reason (Req 6.8), surfaced as an
 *     {@link IntakeFailure}.
 *   - `getRowCount` / `getPreviewRows` / `query` serve the table preview
 *     (Req 7.2, 7.5).
 *
 * ## Dual-environment design
 *
 * The browser DuckDB-WASM bundles load the Wasm module and a worker over
 * URLs/`fetch` and require a real browser worker environment, which is not
 * available under Vitest's jsdom runner. The node-blocking bundle exercises the
 * exact same DuckDB engine over WebAssembly but locates its Wasm/worker assets
 * from the filesystem and exposes a synchronous API.
 *
 * To let the real app and the property tests (tasks 10.2–10.5) both instantiate
 * this service, it is built around an injectable {@link DuckDBConnectionAdapter}
 * — a minimal async "run this SQL, give me plain row objects" abstraction:
 *
 *   - The **application** calls {@link createDuckDBService} with no arguments
 *     and then `init()`, which lazily instantiates the in-memory *browser*
 *     bundle and wraps its async connection.
 *   - **Tests** build a {@link DuckDBConnectionAdapter} around the node-blocking
 *     bundle (as the smoke test does) and pass it to {@link createDuckDBService}
 *     so the service runs headlessly; `init()` is then a no-op.
 *
 * Either way the service logic (typed DDL, coercion, fallback, previews) is
 * identical and independently testable.
 */

import {
  COLUMN_TYPE_TO_DUCKDB_TYPE,
  type CellValue,
  type ColumnSchema,
  type ColumnType,
  type DuckDBService,
  type IntakeError,
  type LoadedTable,
} from "../core/types";
import { parseNumber, normalizeDateToIso } from "../core/coercion";
import { isNullToken } from "../core/predicates";
import { IntakeFailure } from "../core/intake-failure";
import type { DuckDBBundles } from "@duckdb/duckdb-wasm";

/**
 * Minimal connection abstraction the service runs on. Both the browser async
 * connection (whose `query` returns an Apache Arrow table) and the node-blocking
 * connection (synchronous) are adapted to this single async method that yields
 * plain JS row objects.
 */
export interface DuckDBConnectionAdapter {
  /** Execute `sql` and return the result rows as plain objects (empty for DDL/DML). */
  run(sql: string): Promise<Record<string, unknown>[]>;
}

/**
 * Create a {@link DuckDBService}.
 *
 * @param connection An optional pre-built {@link DuckDBConnectionAdapter}. When
 *   provided (e.g. by tests wrapping the node-blocking bundle), `init()` becomes
 *   a no-op and the service uses this connection. When omitted, `init()` lazily
 *   creates the in-memory browser bundle.
 */
export function createDuckDBService(
  connection?: DuckDBConnectionAdapter
): DuckDBService {
  let conn: DuckDBConnectionAdapter | null = connection ?? null;

  function requireConn(): DuckDBConnectionAdapter {
    if (conn === null) {
      throw new Error("DuckDBService.init() must be called before use");
    }
    return conn;
  }

  return {
    async init(): Promise<void> {
      if (conn !== null) {
        // Already initialized (either injected or a prior init()).
        return;
      }
      conn = await createBrowserConnection();
    },

    async createTable(
      tableName: string,
      schema: ColumnSchema[],
      rows: CellValue[][]
    ): Promise<LoadedTable> {
      const connection = requireConn();
      try {
        return await loadTable(connection, tableName, schema, rows);
      } catch (error) {
        // String-fallback failures are handled inside loadTable; reaching here
        // means an unrecoverable failure → table-load-failed (Req 6.8).
        if (error instanceof IntakeFailure) {
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new IntakeFailure(
          tableLoadFailed(tableName, reason)
        );
      }
    },

    async getRowCount(tableName: string): Promise<number> {
      const connection = requireConn();
      const rows = await connection.run(
        `SELECT COUNT(*) AS n FROM ${quoteIdent(tableName)}`
      );
      return Number(rows[0]?.n ?? 0);
    },

    async getPreviewRows(
      tableName: string,
      limit: number
    ): Promise<Record<string, unknown>[]> {
      const connection = requireConn();
      const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
      const rows = await connection.run(
        `SELECT * FROM ${quoteIdent(tableName)} LIMIT ${safeLimit}`
      );
      // The browser DuckDB-WASM Arrow result returns DATE values as raw epoch
      // numbers (ms since the Unix epoch, UTC) rather than Date objects, which
      // would otherwise render as e.g. "1767571200000" in the preview. Look up
      // the table's DATE columns and normalize those cells to ISO YYYY-MM-DD at
      // the data layer, so the UI receives ready-to-display strings. Storage is
      // untouched (Req: fix in the data layer, not the UI).
      const dateColumns = await getDateColumns(connection, tableName);
      if (dateColumns.length > 0) {
        for (const row of rows) {
          for (const col of dateColumns) {
            if (col in row) {
              row[col] = duckDbDateToIso(row[col]);
            }
          }
        }
      }
      return rows;
    },

    // Raw query escape hatch. Unlike `getPreviewRows`, an arbitrary SQL string
    // has no single table whose column types we can resolve, so DATE columns
    // are NOT auto-normalized here — callers that need an ISO date should
    // `CAST(col AS VARCHAR)` in the SQL (as the preview path avoids by design).
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      const connection = requireConn();
      return (await connection.run(sql)) as T[];
    },
  };
}

/**
 * Names of a table's DATE-typed columns, read from `information_schema`.
 *
 * Used by {@link createDuckDBService}'s `getPreviewRows` to decide which
 * columns need epoch→ISO normalization. DuckDB reports a `DATE` column's
 * `data_type` verbatim as `DATE`.
 */
async function getDateColumns(
  conn: DuckDBConnectionAdapter,
  tableName: string
): Promise<string[]> {
  const rows = await conn.run(
    `SELECT column_name, data_type FROM information_schema.columns ` +
      `WHERE table_name = ${quoteString(tableName)}`
  );
  return rows
    .filter((r) => String(r.data_type ?? "").trim().toUpperCase() === "DATE")
    .map((r) => String(r.column_name));
}

/**
 * Convert a DuckDB DATE value — as returned by the Arrow result of the browser
 * bundle — to an ISO `YYYY-MM-DD` string, using UTC so the calendar day never
 * shifts with the local timezone.
 *
 * Handles the shapes a DATE cell can arrive as:
 *   - `number`  — epoch milliseconds (UTC), e.g. `1767571200000` → `"2026-01-05"`.
 *   - `bigint`  — epoch milliseconds as a BigInt; converted via `Number`.
 *   - `Date`    — formatted from its UTC components.
 *   - `null` / `undefined` — left as `null` (SQL NULL stays null).
 *
 * Any already-string value (e.g. from the node-blocking bundle, which may
 * surface DATEs as ISO strings) is returned unchanged. Non-finite / unparseable
 * inputs fall back to `null` rather than throwing.
 */
export function duckDbDateToIso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }

  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "bigint") {
    date = new Date(Number(value));
  } else if (typeof value === "number") {
    date = new Date(value);
  } else {
    return null;
  }

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Load one table: create the explicitly-typed table, insert all coerced rows,
 * and assert the inserted count matches the parsed row count. If a column's
 * values cannot be coerced to its inferred type, that column falls back to
 * `VARCHAR` (`string`) and loading is retried (Req 6.7).
 */
async function loadTable(
  conn: DuckDBConnectionAdapter,
  tableName: string,
  schema: ColumnSchema[],
  rows: CellValue[][]
): Promise<LoadedTable> {
  // The schema actually used may differ from the inferred one when a column
  // falls back to string, so work on a mutable copy.
  const effectiveSchema: ColumnSchema[] = schema.map((c) => ({ ...c }));

  // Resolve coercion up front so a conversion failure demotes the offending
  // column to string BEFORE any DDL/DML runs. We keep demoting until every
  // column's values coerce cleanly (string always succeeds), so the table is
  // only created once with a schema guaranteed to accept the data.
  const coerced = coerceWithFallback(effectiveSchema, rows);

  const ident = quoteIdent(tableName);

  // Explicit typed DDL (Req 6.5) — never CREATE TABLE AS SELECT.
  const columnDefs = effectiveSchema
    .map((col) => `${quoteIdent(col.name)} ${COLUMN_TYPE_TO_DUCKDB_TYPE[col.type]}`)
    .join(", ");
  await conn.run(`CREATE TABLE ${ident} (${columnDefs})`);

  // Insert all rows (Req 6.6). Empty tables are valid (parsers reject truly
  // empty files upstream, but a zero-row insert must still succeed cleanly).
  if (coerced.length > 0) {
    const valuesSql = coerced
      .map((row) => `(${row.join(", ")})`)
      .join(", ");
    await conn.run(`INSERT INTO ${ident} VALUES ${valuesSql}`);
  }

  // Assert inserted row count equals parsed row count (Req 6.6).
  const countRows = await conn.run(`SELECT COUNT(*) AS n FROM ${ident}`);
  const inserted = Number(countRows[0]?.n ?? 0);
  if (inserted !== rows.length) {
    throw new IntakeFailure(
      tableLoadFailed(
        tableName,
        `inserted row count ${inserted} does not match parsed row count ${rows.length}`
      )
    );
  }

  return {
    tableName,
    sourceFileName: tableName,
    schema: effectiveSchema,
    rowCount: inserted,
  };
}

/**
 * Coerce every cell of every row to a DuckDB SQL literal matching its column's
 * type. If any value in a column fails to coerce to the column's inferred type,
 * that column is demoted to `string` in place (mutating `schema`) and all of
 * its values are re-coerced as `VARCHAR` — the string fallback (Req 6.7).
 *
 * @returns A grid of SQL literal strings aligned with `schema`, ready to be
 *   joined into an `INSERT … VALUES` statement.
 */
function coerceWithFallback(
  schema: ColumnSchema[],
  rows: CellValue[][]
): string[][] {
  const columnCount = schema.length;
  const literals: string[][] = rows.map(() => new Array<string>(columnCount));

  for (let col = 0; col < columnCount; col++) {
    let type = schema[col].type;
    let demoted = false;

    // Try to coerce the whole column to its inferred type; on the first failure
    // demote to string and restart the column as VARCHAR.
    // The retry runs at most once because `string` coercion never fails.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        for (let r = 0; r < rows.length; r++) {
          literals[r][col] = toSqlLiteral(cellAt(rows[r], col), type);
        }
        break;
      } catch {
        if (type === "string") {
          // Should be unreachable (string coercion is total), but guard anyway.
          for (let r = 0; r < rows.length; r++) {
            const cell = cellAt(rows[r], col);
            literals[r][col] = cell === null || isNullToken(cell)
              ? "NULL"
              : quoteString(String(cell));
          }
          break;
        }
        type = "string";
        demoted = true;
      }
    }

    if (demoted) {
      schema[col] = { name: schema[col].name, type: "string" };
    }
  }

  return literals;
}

/**
 * Convert a single cell to a typed DuckDB SQL literal.
 *
 *   - `null` or any {@link isNullToken} value → `NULL` for every type.
 *   - `number` → a bare numeric literal via {@link parseNumber} (handles
 *     currency, thousands separators, percent → decimal fraction).
 *   - `boolean` → `TRUE`/`FALSE` from `true`/`yes` vs `false`/`no`.
 *   - `date` → `DATE 'YYYY-MM-DD'` via {@link normalizeDateToIso}.
 *   - `string` → a single-quote-escaped `VARCHAR` literal.
 *
 * @throws {RangeError} If a non-null value cannot be coerced to `type`
 *   (number/boolean/date). The caller catches this to trigger string fallback.
 */
function toSqlLiteral(cell: CellValue, type: ColumnType): string {
  // NullTokens (and real nulls) are stored as SQL NULL for every type.
  if (cell === null || isNullToken(cell)) {
    return "NULL";
  }
  const value = cell;

  switch (type) {
    case "number": {
      const n = parseNumber(value); // throws RangeError if not a number
      return numberLiteral(n);
    }
    case "boolean": {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes") {
        return "TRUE";
      }
      if (normalized === "false" || normalized === "no") {
        return "FALSE";
      }
      throw new RangeError(`Not a boolean literal: ${JSON.stringify(value)}`);
    }
    case "date": {
      const iso = normalizeDateToIso(value); // throws RangeError if not a date
      return `DATE ${quoteString(iso)}`;
    }
    case "string":
    default:
      return quoteString(value);
  }
}

/**
 * Render a finite JS number as a DuckDB `DOUBLE` literal. Values in scientific
 * notation (from very large/small magnitudes) are wrapped in a `CAST(… AS
 * DOUBLE)` so DuckDB parses the exponent form unambiguously.
 */
function numberLiteral(n: number): string {
  const s = n.toString();
  if (/[eE]/.test(s)) {
    return `CAST('${s}' AS DOUBLE)`;
  }
  return s;
}

/** Read the cell at `col` from a (possibly ragged/undefined) row as a CellValue. */
function cellAt(row: CellValue[], col: number): CellValue {
  if (!Array.isArray(row)) {
    return null;
  }
  const cell = row[col];
  return cell === undefined ? null : cell;
}

/** Quote a SQL identifier (table/column name) by doubling embedded double quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a SQL string literal by doubling embedded single quotes. */
function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a `table-load-failed` IntakeError naming the file and the reason (Req 6.8). */
function tableLoadFailed(sourceFileName: string, reason: string): IntakeError {
  return {
    sourceFileName,
    stage: "loading",
    kind: "table-load-failed",
    message: `Failed to load table for "${sourceFileName}": ${reason}`,
  };
}

/**
 * Lazily instantiate the in-memory *browser* DuckDB-WASM bundle and return a
 * {@link DuckDBConnectionAdapter} over its async connection. Used only by the
 * real app (`init()` with no injected connection); tests inject their own
 * adapter and never reach this path.
 *
 * The bundle is selected from the DuckDB-WASM assets bundled with the package
 * and served as local app URLs (no CDN/network access at runtime), instantiated with `:memory:` (no persistent backing store, Req 8.1),
 * and its Arrow query results are converted to plain row objects.
 */
async function createBrowserConnection(): Promise<DuckDBConnectionAdapter> {
  const duckdb = await import("@duckdb/duckdb-wasm");

  // Resolve the DuckDB-WASM assets from the installed package as local,
  // Vite-fingerprinted URLs ("?url" imports) so NOTHING is fetched from a CDN
  // at runtime (the jsDelivr worker is blocked by the browser's same-origin
  // policy). These imports live inside the browser-init path and are loaded
  // dynamically so Vitest's Node runner never has to resolve the "?url"
  // specifiers.
  const [mvpWasm, mvpWorker, ehWasm, ehWorker] = await Promise.all([
    import("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url"),
  ]);

  const bundles: DuckDBBundles = {
    mvp: {
      mainModule: mvpWasm.default,
      mainWorker: mvpWorker.default,
    },
    eh: {
      mainModule: ehWasm.default,
      mainWorker: ehWorker.default,
    },
  };
  const bundle = await duckdb.selectBundle(bundles);

  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // ':memory:' = in-memory database with no persistent backing store (Req 8.1).
  await db.open({ path: ":memory:" });

  const connection = await db.connect();

  return {
    async run(sql: string): Promise<Record<string, unknown>[]> {
      const table = await connection.query(sql);
      // Arrow Table → plain row objects.
      return table.toArray().map((row) => row.toJSON() as Record<string, unknown>);
    },
  };
}
