/**
 * The lab shelf model (pure; no React, no DOM): which jars the shelf shows for
 * the loaded tables and the stitched result, how full each jar is, how its
 * label reads, and how often the coil may crackle. The shelf is decorative, so
 * this holds no state of its own: it is a function of what the app already has.
 */

/** The shelf shows at this viewport width and above (the right gutter is empty). */
export const SHELF_MIN_WIDTH_PX = 1440;
/** At most this many jars; more tables become one "+N" jar. */
export const SHELF_MAX_JARS = 6;
/** The liquid level is clamped to this range (fraction of the jar's inside height). */
export const JAR_LEVEL_MIN = 0.3;
export const JAR_LEVEL_MAX = 0.85;
/** Table names longer than this are cut with an ellipsis (the full name is the tooltip). */
export const JAR_NAME_MAX_CHARS = 12;
/** The idle coil crackle waits at least this long between crackles. */
export const CRACKLE_MIN_GAP_MS = 20000;
export const CRACKLE_MAX_GAP_MS = 35000;

/** What the shelf needs to know about a table. */
export interface ShelfTable {
  tableName: string;
  rowCount: number;
}

export type JarKind = "table" | "stitched" | "more";

export interface Jar {
  /** Stable across renders, so the same jar keeps its element (and does not pop again). */
  key: string;
  kind: JarKind;
  /** The full table name ("" for the "+N" jar). */
  name: string;
  /** The name as shown on the label (truncated). */
  label: string;
  rowCount: number;
  /** Liquid level, JAR_LEVEL_MIN to JAR_LEVEL_MAX. */
  level: number;
  /** For the "+N" jar: how many tables it stands for. */
  more: number;
  /** The accessible name of a table jar's button, null for the "+N" jar. */
  ariaLabel: string | null;
}

function cleanCount(n: number): number {
  if (n === Infinity) return Number.MAX_SAFE_INTEGER;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The liquid level for a row count: gentle (a log scale), so ten thousand rows
 * is not ten thousand times a single row, and clamped so an empty table still
 * has some liquid and a huge one does not overflow.
 */
export function liquidLevel(rowCount: number): number {
  const rows = cleanCount(rowCount);
  const level = JAR_LEVEL_MIN + 0.12 * Math.log10(Math.max(1, rows));
  return Math.min(JAR_LEVEL_MAX, Math.max(JAR_LEVEL_MIN, level));
}

/** Cut a name to `max` characters, ending in an ellipsis when it was cut. */
export function truncateName(name: string, max: number = JAR_NAME_MAX_CHARS): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  return `${chars.slice(0, Math.max(1, max - 1)).join("")}\u2026`;
}

/** "1 row" or "1,234 rows". */
export function rowsText(rowCount: number): string {
  const n = cleanCount(rowCount);
  return `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
}

/** The accessible name of a jar button. */
export function jarAriaLabel(name: string, rowCount: number): string {
  return `Go to table ${name}, ${rowsText(rowCount)}`;
}

function tableJar(table: ShelfTable, kind: "table" | "stitched"): Jar {
  const rowCount = cleanCount(table.rowCount);
  return {
    key: `${kind === "stitched" ? "s" : "t"}:${table.tableName}`,
    kind,
    name: table.tableName,
    label: truncateName(table.tableName),
    rowCount,
    level: liquidLevel(rowCount),
    more: 0,
    ariaLabel: jarAriaLabel(table.tableName, rowCount),
  };
}

/**
 * One jar per loaded table, then the stitched result's own jar. With more than
 * SHELF_MAX_JARS in all, the shelf shows SHELF_MAX_JARS jars (the stitched
 * result always keeps its place) and one "+N" jar for the rest.
 */
export function buildJars(tables: readonly ShelfTable[], stitched: ShelfTable | null): Jar[] {
  const total = tables.length + (stitched === null ? 0 : 1);
  const room = stitched === null ? SHELF_MAX_JARS : SHELF_MAX_JARS - 1;
  const shown = total <= SHELF_MAX_JARS ? tables : tables.slice(0, room);
  const jars = shown.map((t) => tableJar(t, "table"));
  if (stitched !== null) jars.push(tableJar(stitched, "stitched"));
  if (total > SHELF_MAX_JARS) {
    const more = total - SHELF_MAX_JARS;
    jars.push({
      key: "more",
      kind: "more",
      name: "",
      label: `+${more}`,
      rowCount: 0,
      level: JAR_LEVEL_MIN,
      more,
      ariaLabel: null,
    });
  }
  return jars;
}

/** How long to wait before the next idle crackle, from a number in [0, 1). */
export function nextCrackleDelayMs(roll: number): number {
  const r = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  return Math.round(CRACKLE_MIN_GAP_MS + r * (CRACKLE_MAX_GAP_MS - CRACKLE_MIN_GAP_MS));
}
