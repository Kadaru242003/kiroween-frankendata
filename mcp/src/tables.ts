/** Table lookup helpers shared by the tools. */
import { discoverStitchTables } from "../../src/core/chat/queryable-tables";
import { buildStitchedTableDescriptor } from "../../src/core/stitching/stitch-controller";
import type { LoadedTable } from "../../src/core/types";
import { toolError } from "./errors";
import type { Session } from "./session";

/** Loaded tables plus the names of present stitch_ tables. */
export async function queryableNames(session: Session): Promise<string[]> {
  const db = await session.db();
  const stitched = await discoverStitchTables(db);
  return [...session.tables().map((t) => t.tableName), ...stitched.map((t) => t.tableName)];
}

/** A loaded table or a stitched result table, or a table-not-found error. */
export async function findTable(session: Session, name: string): Promise<LoadedTable> {
  const loaded = session.tables().find((t) => t.tableName === name);
  if (loaded) return loaded;
  const db = await session.db();
  const stitched = await discoverStitchTables(db);
  if (stitched.some((t) => t.tableName === name)) {
    return buildStitchedTableDescriptor(db, name);
  }
  const available = await queryableNames(session);
  throw toolError(
    "table-not-found",
    `No table named "${name.slice(0, 100)}". Available tables: ${available.join(", ") || "(none loaded)"}.`
  );
}

/** The tables selected for stitching (all loaded unless a subset was chosen). */
export function selectedTables(session: Session): LoadedTable[] {
  const names = session.selection.names;
  return session.tables().filter((t) => names === null || names.includes(t.tableName));
}
