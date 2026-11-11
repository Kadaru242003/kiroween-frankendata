/**
 * ChartSpec validation + category shaping for "Ask the Lab" (Feature 3, task
 * 10).
 *
 * {@link validateChartSpec} checks a model- or chip-supplied {@link ChartSpec}
 * against the actual {@link ResultTable} columns and returns the chart to
 * render or `undefined` ("no chart") — the controller then shows the table
 * without a chart, never failing (Req 5.8). A spec is accepted only when:
 *   - its `type` is one of the allowed chart types;
 *   - both `x` and `y` are result column names;
 *   - the `y` column is numeric (its first non-empty value is a JS number,
 *     since the result rows are already converted to {@link DisplayValue}s).
 *
 * For now only `bar` renders; `line`/`pie` are treated as "no chart" (the
 * optional task adds them) WITHOUT failing — a line/pie spec that is otherwise
 * valid simply yields `undefined` here so the table still shows.
 *
 * {@link shapeCategories} caps/bins a chart's categories to
 * {@link ASK_CHART_MAX_CATEGORIES}: a pie sums the overflow into one "Other"
 * slice; a bar truncates to the first N (Req 8.3). It is pure and used by the
 * chart components.
 *
 * Framework-agnostic: no React, no DOM.
 */

import {
  ASK_CHART_MAX_CATEGORIES,
  type ChartSpec,
  type ChartType,
  type DisplayValue,
} from "./types.js";

/** Chart types currently RENDERED (the others validate as "no chart" for now). */
const RENDERABLE_TYPES: ReadonlySet<ChartType> = new Set<ChartType>(["bar"]);
/** All chart types the model may legitimately return (shape is valid). */
const ALLOWED_TYPES: ReadonlySet<ChartType> = new Set<ChartType>([
  "bar",
  "line",
  "pie",
]);

export interface ValidateChartOptions {
  /**
   * Treat a well-formed but not-yet-rendered type (line/pie) as "no chart"
   * rather than invalid. Defaults to true. When false, only the type-allowed
   * check applies (used by tests that assert shape validity independent of
   * which types render).
   */
  renderableOnly?: boolean;
}

/**
 * Validate a {@link ChartSpec} against the result columns + rows. Returns the
 * spec to render, or `undefined` to drop the chart (Req 5.8). Never throws.
 */
export function validateChartSpec(
  chart: ChartSpec | undefined,
  columns: string[],
  rows: DisplayValue[][],
  options: ValidateChartOptions = {}
): ChartSpec | undefined {
  const renderableOnly = options.renderableOnly ?? true;
  if (!chart) return undefined;
  if (!ALLOWED_TYPES.has(chart.type)) return undefined;

  const xi = columns.indexOf(chart.x);
  const yi = columns.indexOf(chart.y);
  if (xi === -1 || yi === -1) return undefined;
  if (chart.x === chart.y) return undefined;

  if (!isNumericColumn(rows, yi)) return undefined;

  // Shape is valid; only render the currently-supported types (bar). A valid
  // line/pie spec is dropped here (shown as the table only) until the optional
  // task adds those components — WITHOUT failing.
  if (renderableOnly && !RENDERABLE_TYPES.has(chart.type)) return undefined;

  return chart;
}

/** True when the column at `index` has a numeric first non-empty value. */
function isNumericColumn(rows: DisplayValue[][], index: number): boolean {
  for (const row of rows) {
    const v = row[index];
    if (v === "" || v === null || v === undefined) continue;
    return typeof v === "number" && Number.isFinite(v);
  }
  // An all-empty (or empty) result is not a chartable numeric column.
  return false;
}

/** One category datum for a chart: a label and its numeric value. */
export interface CategoryDatum {
  label: string;
  value: number;
}

/**
 * Extract and shape the (x,y) category data for a validated chart from the
 * result rows, capping to {@link ASK_CHART_MAX_CATEGORIES} (Req 8.3):
 *   - `pie`: categories beyond the cap are summed into a single "Other" slice;
 *   - `bar` (and others): truncated to the first N categories.
 *
 * Labels are the x column's display value as text; values are the numeric y.
 * Non-numeric y cells contribute 0. Pure.
 */
export function shapeCategories(
  type: ChartType,
  columns: string[],
  rows: DisplayValue[][],
  x: string,
  y: string,
  maxCategories: number = ASK_CHART_MAX_CATEGORIES
): CategoryDatum[] {
  const xi = columns.indexOf(x);
  const yi = columns.indexOf(y);
  if (xi === -1 || yi === -1) return [];

  const data: CategoryDatum[] = rows.map((row) => ({
    label: toLabel(row[xi]),
    value: toNumber(row[yi]),
  }));

  if (data.length <= maxCategories) return data;

  if (type === "pie") {
    const head = data.slice(0, maxCategories - 1);
    const rest = data.slice(maxCategories - 1);
    const otherValue = rest.reduce((sum, d) => sum + d.value, 0);
    return [...head, { label: "Other", value: otherValue }];
  }

  // bar / line: truncate to the first N.
  return data.slice(0, maxCategories);
}

function toLabel(v: DisplayValue): string {
  return typeof v === "string" ? v : String(v);
}

function toNumber(v: DisplayValue): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
