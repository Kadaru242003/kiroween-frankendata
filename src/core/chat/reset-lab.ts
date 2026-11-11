/**
 * Lab reset + DuckDB table teardown for FrankenData (bug fix: demo reloads).
 *
 * {@link dropAllTables} removes every base table in the DuckDB catalog —
 * originals, Feature 2 cleaned copies (`stitch_<n>_clean_*`), and joined results
 * (`stitch_<n>_result`) — so a "Reset lab" returns DuckDB to empty. It is
 * BEST-EFFORT and never throws: a catalog read failure or an individual
 * `DROP` failure (e.g. DuckDB mid-operation) is swallowed, and remaining tables
 * are still attempted. Views are dropped too, defensively, though the app only
 * creates tables.
 *
 * Framework-agnostic: it only touches the injected {@link DuckDBService.query}.
 * The React-side orchestration (clearing the intake/stitch/ask stores and undo
 * history) lives in `App.tsx`, which calls this first.
 */

import { quoteIdent } from "../stitching/sql-escape.js";
import type { DuckDBService } from "../types.js";

interface CatalogRow {
  table_name: string;
  table_type?: string;
}

/**
 * Drop every table (and view) in the current DuckDB `main` schema. Returns the
 * names it attempted to drop (for diagnostics/tests). Never throws.
 */
export async function dropAllTables(service: DuckDBService): Promise<string[]> {
  let rows: CatalogRow[];
  try {
    rows = await service.query<CatalogRow>(
      "SELECT table_name, table_type FROM information_schema.tables " +
        "WHERE table_schema = 'main'"
    );
  } catch {
    // Catalog unreadable (e.g. mid-operation) — nothing we can safely drop.
    return [];
  }

  const dropped: string[] = [];
  for (const row of rows) {
    const name = String(row.table_name ?? "");
    if (!name) continue;
    const isView = String(row.table_type ?? "").toUpperCase().includes("VIEW");
    const ident = quoteIdent(name);
    try {
      await service.query(
        isView
          ? `DROP VIEW IF EXISTS ${ident}`
          : `DROP TABLE IF EXISTS ${ident}`
      );
      dropped.push(name);
    } catch {
      // A single drop failure must not stop the rest (Req: never throw).
      try {
        // A table reported as a view (or vice-versa) — try the other form once.
        await service.query(
          isView
            ? `DROP TABLE IF EXISTS ${ident}`
            : `DROP VIEW IF EXISTS ${ident}`
        );
        dropped.push(name);
      } catch {
        /* give up on this one; continue */
      }
    }
  }
  return dropped;
}
