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
import { formatNumber, humanize, wrapLabel } from "../../../core/chat/format";
import "./chart.css";

export interface BarChartProps {
  spec: ChartSpec;
  columns: string[];
  rows: DisplayValue[][];
}

/** Max characters of an x label shown before truncating (full text in title). */
const WIDTH = 720;
const HEIGHT = 280;
const PAD_RIGHT = 16;
const PAD_TOP = 18;
const PAD_BOTTOM = 56;
/** Approximate glyph width (px, at the 11px tick font) used to reserve y-axis room. */
const TICK_CHAR_WIDTH = 6.5;

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
  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const maxTick = formatNumber(maxValue);
  // Reserve enough left padding for the widest tick label so it never clips.
  const padLeft = Math.max(44, Math.ceil(maxTick.length * TICK_CHAR_WIDTH) + 16);
  const plotWidth = WIDTH - padLeft - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const scale = maxValue > 0 ? plotHeight / maxValue : 0;
  const slot = plotWidth / data.length;
  const barWidth = Math.max(1, slot * 0.7);
  // Labels wrap to two lines before truncating; the full text is in a tooltip.
  const charsPerLine = Math.max(5, Math.floor(slot / 6.5));
  const title = `${humanize(spec.y)} by ${humanize(spec.x).toLowerCase()}`;
  return (
    <figure className="ask-chart" aria-label={`Bar chart of ${spec.y} by ${spec.x}`}>
      <figcaption className="ask-chart__caption">{title}</figcaption>
      <svg
        className="ask-chart__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Axes */}
        <line className="ask-chart__axis" x1={padLeft} y1={PAD_TOP} x2={padLeft} y2={PAD_TOP + plotHeight} />
        <line className="ask-chart__axis" x1={padLeft} y1={PAD_TOP + plotHeight} x2={padLeft + plotWidth} y2={PAD_TOP + plotHeight} />
        {/* Max-value tick label (plain text). */}
        <text className="ask-chart__tick" x={padLeft - 6} y={PAD_TOP + 4} textAnchor="end">
          {maxTick}
        </text>
        <text className="ask-chart__tick" x={padLeft - 6} y={PAD_TOP + plotHeight} textAnchor="end">
          0
        </text>
        {data.map((d, i) => {
          const barHeight = d.value > 0 ? d.value * scale : 0;
          const x = padLeft + i * slot + (slot - barWidth) / 2;
          const y = PAD_TOP + plotHeight - barHeight;
          const full = `${d.label}: ${formatNumber(d.value)}`;
          const lines = wrapLabel(d.label, charsPerLine);
          return (
            <g key={`${d.label}-${i}`}>
              <rect className="ask-chart__bar" x={x} y={y} width={barWidth} height={barHeight}>
                <title>{full}</title>
              </rect>
              {/* Value label above the bar (plain text). */}
              <text className="ask-chart__value" x={x + barWidth / 2} y={y - 4} textAnchor="middle">
                {formatNumber(d.value)}
              </text>
              {/* X label under the bar: up to two lines, full text in the tooltip. */}
              <text
                className="ask-chart__xlabel"
                x={x + barWidth / 2}
                y={PAD_TOP + plotHeight + 14}
                textAnchor="middle"
              >
                {lines.map((line, li) => (
                  <tspan key={li} x={x + barWidth / 2} dy={li === 0 ? 0 : 13}>
                    {line}
                  </tspan>
                ))}
                <title>{d.label}</title>
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export default BarChart;
