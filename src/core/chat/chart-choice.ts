/**
 * Deterministic chart choice for "Ask the Lab" results (Smarter Ask).
 *
 * A pure function of the result columns, the rows, and the set of temporal
 * (DATE or TIMESTAMP) columns. It reads only column names, the set, and the
 * first non-empty value of each column, so the same shape always gives the same
 * choice, regardless of the set's iteration order.
 */
import type { ChartSpec, DisplayValue } from "./types.js";

export const ASK_LINE_CHART_MIN_POINTS = 2;
export const ASK_LINE_CHART_MAX_POINTS = 200;

/** True when the column's first non-empty value is a finite number. */
export function isNumericColumn(rows: DisplayValue[][], index: number): boolean {
  for (const row of rows) {
    const v = row[index];
    if (v === "" || v === null || v === undefined) continue;
    return typeof v === "number" && Number.isFinite(v);
  }
  return false;
}

/**
 * line: exactly one temporal plus one numeric column, at least 2 rows.
 * bar: exactly one text (non-temporal, non-numeric) plus one numeric column.
 * Anything else: undefined.
 */
export function chooseChart(
  columns: string[],
  rows: DisplayValue[][],
  temporal: ReadonlySet<string>
): ChartSpec | undefined {
  if (columns.length !== 2) return undefined;
  if (columns[0] === columns[1]) return undefined;
  const numeric = [isNumericColumn(rows, 0), isNumericColumn(rows, 1)];
  const isTemporal = [temporal.has(columns[0]), temporal.has(columns[1])];
  for (const [t, n] of [
    [0, 1],
    [1, 0],
  ] as const) {
    if (isTemporal[t] && numeric[n] && !numeric[t]) {
      if (rows.length < ASK_LINE_CHART_MIN_POINTS) return undefined;
      return { type: "line", x: columns[t], y: columns[n] };
    }
  }
  for (const [c, n] of [
    [0, 1],
    [1, 0],
  ] as const) {
    if (!isTemporal[c] && !numeric[c] && numeric[n] && !isTemporal[n] && rows.length >= 1) {
      return { type: "bar", x: columns[c], y: columns[n] };
    }
  }
  return undefined;
}

export interface LinePoint {
  label: string;
  value: number;
}

/** Points sorted by x ascending, evenly sampled to at most `max` (first and last kept). */
export function shapeLinePoints(
  columns: string[],
  rows: DisplayValue[][],
  x: string,
  y: string,
  max: number = ASK_LINE_CHART_MAX_POINTS
): LinePoint[] {
  const xi = columns.indexOf(x);
  const yi = columns.indexOf(y);
  if (xi === -1 || yi === -1) return [];
  const points: LinePoint[] = [];
  for (const row of rows) {
    const v = row[yi];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    points.push({ label: String(row[xi]), value: v });
  }
  points.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  if (points.length <= max) return points;
  if (max < 2) return points.slice(0, max);
  const out: LinePoint[] = [];
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  }
  return out;
}
