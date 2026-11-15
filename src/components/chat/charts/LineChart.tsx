/**
 * Hand-built SVG line chart for "Ask the Lab" (Smarter Ask). Used for a result
 * with one date or timestamp column plus one numeric column (see
 * `chooseChart`). Same style as the bar chart. All labels are plain text. A
 * visually hidden table lists every plotted point for screen readers.
 */
import { shapeLinePoints } from "../../../core/chat/chart-choice";
import { formatNumber, humanize } from "../../../core/chat/format";
import type { ChartSpec, DisplayValue } from "../../../core/chat/types";
import "./chart.css";

export interface LineChartProps {
  spec: ChartSpec;
  columns: string[];
  rows: DisplayValue[][];
}

const WIDTH = 720;
const HEIGHT = 280;
const PAD_RIGHT = 16;
const PAD_TOP = 18;
const PAD_BOTTOM = 40;
const TICK_CHAR_WIDTH = 6.5;

export function LineChart({ spec, columns, rows }: LineChartProps) {
  const points = shapeLinePoints(columns, rows, spec.x, spec.y);
  if (points.length < 2) return null;
  const widest = Math.max(formatNumber(Math.max(0, ...points.map((p) => p.value))).length, formatNumber(Math.min(0, ...points.map((p) => p.value))).length);
  // Reserve enough left padding for the widest tick label so it never clips.
  const PAD_LEFT = Math.max(44, Math.ceil(widest * TICK_CHAR_WIDTH) + 16);
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const values = points.map((p) => p.value);
  const minY = Math.min(0, ...values);
  const maxY = Math.max(0, ...values);
  const span = maxY - minY || 1;
  const xAt = (i: number) => PAD_LEFT + (i * plotWidth) / (points.length - 1);
  const yAt = (v: number) => PAD_TOP + plotHeight - ((v - minY) / span) * plotHeight;
  const path = points.map((p, i) => `${xAt(i)},${yAt(p.value)}`).join(" ");
  const label = `Line chart of ${spec.y} over ${spec.x}`;
  return (
    <figure className="ask-chart" aria-label={label}>
      <figcaption className="ask-chart__caption">
        {humanize(spec.y)} over {humanize(spec.x).toLowerCase()}
      </figcaption>
      <svg
        className="ask-chart__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${label}, ${points.length} points from ${points[0].label} to ${points[points.length - 1].label}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <line className="ask-chart__axis" x1={PAD_LEFT} y1={PAD_TOP} x2={PAD_LEFT} y2={PAD_TOP + plotHeight} />
        <line className="ask-chart__axis" x1={PAD_LEFT} y1={PAD_TOP + plotHeight} x2={PAD_LEFT + plotWidth} y2={PAD_TOP + plotHeight} />
        <text className="ask-chart__tick" x={PAD_LEFT - 6} y={PAD_TOP + 4} textAnchor="end">
          {formatNumber(maxY)}
        </text>
        <text className="ask-chart__tick" x={PAD_LEFT - 6} y={PAD_TOP + plotHeight} textAnchor="end">
          {formatNumber(minY)}
        </text>
        <text className="ask-chart__xlabel" x={PAD_LEFT} y={HEIGHT - 8} textAnchor="start">
          {points[0].label}
        </text>
        <text className="ask-chart__xlabel" x={PAD_LEFT + plotWidth} y={HEIGHT - 8} textAnchor="end">
          {points[points.length - 1].label}
        </text>
        <polyline className="ask-chart__line" points={path} />
        {points.map((p, i) => (
          <circle key={`${p.label}-${i}`} className="ask-chart__point" cx={xAt(i)} cy={yAt(p.value)} r={3}>
            <title>{`${p.label}: ${formatNumber(p.value)}`}</title>
          </circle>
        ))}
      </svg>
      <table className="ask-chart__sr-table">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{spec.x}</th>
            <th scope="col">{spec.y}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={`${p.label}-${i}`}>
              <td>{p.label}</td>
              <td>{formatNumber(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export default LineChart;
