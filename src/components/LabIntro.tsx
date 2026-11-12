/**
 * LabIntro and header decorations for the landing title.
 *
 * {@link LabIntro} is the one-time "It's alive!" overlay: inline SVG lightning
 * bolts and a white flash, positioned absolutely over the header with
 * pointer-events: none, so it never blocks clicks or shifts layout.
 *
 * {@link TeslaNode} and {@link TitleSeam} are small inline-flow pieces the App
 * places in the real title layout (a node on each side of the title in a flex
 * row, and the stitched seam inline in the gap of the "FrankenData" wordmark).
 * Placing them in normal flow, instead of absolutely over the text, keeps the
 * subtitle fully readable (no decoration covering any word).
 *
 * All decoration is aria-hidden. Motion lives in LabIntro.css (and the
 * title/subtitle rules in App.css); CSS animations run once on first paint, so
 * the intro plays once per page load with no JS. Under prefers-reduced-motion
 * the CSS shows the final static state (seam and nodes visible, no sparks).
 * Only transform, opacity, stroke-dashoffset, text-shadow, box-shadow, and
 * filter are animated. No monster or face is drawn: only lightning, sparks,
 * Tesla nodes, and stitches.
 */

import { type JSX } from "react";
import "./LabIntro.css";

/** The one-time strike overlay (bolts + flash) layered over the header. */
export function LabIntro(): JSX.Element {
  return (
    <div className="lab-intro" aria-hidden="true">
      <div className="lab-intro__flash" />
      <svg
        className="lab-intro__bolt lab-intro__bolt--left"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <polyline
          className="lab-intro__bolt-path"
          points="2,2 34,30 20,42 48,64 38,76 60,98"
          fill="none"
        />
      </svg>
      <svg
        className="lab-intro__bolt lab-intro__bolt--right"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <polyline
          className="lab-intro__bolt-path"
          points="98,2 66,30 80,42 52,64 62,76 40,98"
          fill="none"
        />
      </svg>
    </div>
  );
}

/**
 * A compact Tesla coil node: a glowing ball on a short base, no taller than the
 * title line height. A spark arc flashes toward the title every few seconds,
 * staying within the title row. `side` only aims the arc.
 */
export function TeslaNode({ side }: { side: "left" | "right" }): JSX.Element {
  const arc =
    side === "left"
      ? "17,12 28,17 23,22 36,26"
      : "15,12 4,17 9,22 -4,26";
  return (
    <svg
      className={`lab-node lab-node--${side}`}
      viewBox="0 0 32 40"
      aria-hidden="true"
    >
      {/* Short base: a small trapezoid coil, not a tall pole over text. */}
      <path className="lab-node__base" d="M10 40 L22 40 L20 28 L12 28 Z" />
      <circle className="lab-node__ball" cx="16" cy="20" r="8" />
      <polyline className="lab-node__arc" points={arc} fill="none" />
    </svg>
  );
}

/**
 * The stitched seam shown inline in the "FrankenData" gap (cutting through the
 * "e" region visually), limited to the title cap height. Sews itself in on load
 * and stays visible as part of the logo.
 */
export function TitleSeam(): JSX.Element {
  return (
    <svg className="lab-title__seam-svg" viewBox="0 0 12 48" aria-hidden="true">
      <line className="lab-seam-line" x1="6" y1="2" x2="6" y2="46" />
      <g className="lab-seam-stitches">
        <line className="lab-seam-stitch" x1="1" y1="6" x2="11" y2="12" />
        <line className="lab-seam-stitch" x1="11" y1="6" x2="1" y2="12" />
        <line className="lab-seam-stitch" x1="1" y1="18" x2="11" y2="24" />
        <line className="lab-seam-stitch" x1="11" y1="18" x2="1" y2="24" />
        <line className="lab-seam-stitch" x1="1" y1="30" x2="11" y2="36" />
        <line className="lab-seam-stitch" x1="11" y1="30" x2="1" y2="36" />
        <line className="lab-seam-stitch" x1="1" y1="42" x2="11" y2="48" />
        <line className="lab-seam-stitch" x1="11" y1="42" x2="1" y2="48" />
      </g>
    </svg>
  );
}

export default LabIntro;
