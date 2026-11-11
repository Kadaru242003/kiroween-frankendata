/**
 * BarChart — a small hand-built SVG bar chart in the lab theme (Feature 3, task
 * 10; Req 8.1–8.4).
 *
 * Presentational only, no charting dependency. It renders one vertical bar per
 * category from a validated bar {@link ChartSpec}: x is the category column, y
 * the numeric column. Categories are capped/shaped by {@link shapeCategories}
 * (bar truncates to {@link ASK_CHART_MAX_CATEGORIES}). Colors come from the lab
 * theme tokens (`src/theme/tokens.ts` via the `--lab-*`/`--text-*` CSS vars);
 * axis labels and value labels are PLAIN TEXT with ≥4.5:1 contrast. Long x
 * labels are truncated for display with the full text in a `<title>` tooltip.
 *
 * The component assumes the spec was already validated against the columns by
 * {@link validateChartSpec} (y is numeric), so it never throws on the data.
 */

import {
  ASK_CHART_MAX_CATEGORIES,
  type ChartSpec,
  type DisplayValue,
} from "../../../core/chat/types";
import { shapeCategories, type CategoryDatum } from "../../../core/chat/chart-spec";
import "./chart.css";

export interface BarChartProps {
  spec: ChartSpec;
  columns: string[];
  rows: DisplayValue[][];
}

/** Max characters of an x label shown before truncating (full text in title). */
const MAX_LABEL_CHARS = 10;

const WIDTH = 480;
const HEIGHT = 240;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 48;

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

export function BarChart({ spec, columns, rows }: BarChartProps) {
  const data: CategoryDatum[] = shapeCategories(
    "bar",
    columns,
    rows,
    spec.x,
    spec.y,
    ASK_CHART_MAX_CATEGORIES
  );

  if (data.length === 0) return null;

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const scale = maxValue > 0 ? plotHeight / maxValue : 0;
  const slot = plotWidth / data.length;
  const barWidth = Math.max(1, slot * 0.7);

  return (
    <figure className="ask-chart" aria-label={`Bar chart of ${spec.y} by ${spec.x}`}>
      <figcaption className="ask-chart__caption">
        {spec.y} by {spec.x}
      </figcaption>
      <svg
        className="ask-chart__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Axes */}
        <line
          className="ask-chart__axis"
          x1={PAD_LEFT}
          y1={PAD_TOP}
          x2={PAD_LEFT}
          y2={PAD_TOP + plotHeight}
        />
        <line
          className="ask-chart__axis"
          x1={PAD_LEFT}
          y1={PAD_TOP + plotHeight}
          x2={PAD_LEFT + plotWidth}
          y2={PAD_TOP + plotHeight}
        />
        {/* Max-value tick label (plain text). */}
        <text className="ask-chart__tick" x={PAD_LEFT - 6} y={PAD_TOP + 4} textAnchor="end">
          {formatNumber(maxValue)}
        </text>
        <text
          className="ask-chart__tick"
          x={PAD_LEFT - 6}
          y={PAD_TOP + plotHeight}
          textAnchor="end"
        >
          0
        </text>

        {data.map((d, i) => {
          const barHeight = d.value > 0 ? d.value * scale : 0;
          const x = PAD_LEFT + i * slot + (slot - barWidth) / 2;
          const y = PAD_TOP + plotHeight - barHeight;
          const full = `${d.label}: ${formatNumber(d.value)}`;
          return (
            <g key={`${d.label}-${i}`}>
              <rect
                className="ask-chart__bar"
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
              >
                <title>{full}</title>
              </rect>
              {/* Value label above the bar (plain text). */}
              <text
                className="ask-chart__value"
                x={x + barWidth / 2}
                y={y - 3}
                textAnchor="middle"
              >
                {formatNumber(d.value)}
              </text>
              {/* X label under the bar, truncated with a full-text tooltip. */}
              <text
                className="ask-chart__xlabel"
                x={x + barWidth / 2}
                y={PAD_TOP + plotHeight + 14}
                textAnchor="middle"
              >
                {truncateLabel(d.label)}
                <title>{d.label}</title>
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** Compact numeric label (integers as-is; otherwise up to 2 decimals). */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export default BarChart;
