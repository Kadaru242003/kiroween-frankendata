/**
 * The Tesla coil at the top of the shelf (SVG, aria-hidden, no pointer).
 *
 *  - powered (tables loaded): a soft cyan glow; unpowered (before data, and
 *    after Reset lab): the glow fades out;
 *  - idle crackle: a faint little arc now and then (the shelf decides when);
 *  - wake: a big forked arc, drawn from the same generator and timing as the
 *    wake strike so it flickers with it;
 *  - Confirm & stitch: a small spark.
 * Under reduced motion or Calm Frank none of the arcs is rendered.
 */
import { useState, type JSX } from "react";
import { generateBolt, pointsToPath } from "../../core/frank/lightning";

/** The big arc: the generator's bolt, ending on the coil's top terminal. */
function BigArc({ seq }: { seq: number }): JSX.Element {
  const [paths] = useState(() => {
    const seed = (Date.now() ^ Math.imul(seq + 1, 2654435761)) >>> 0;
    const bolt = generateBolt({ seed, targetX: 42, targetY: 90, width: 84 });
    return [bolt.main, ...bolt.branches].map((points, i) => ({
      d: pointsToPath(points),
      main: i === 0,
    }));
  });
  return (
    <g className="shelf-arc shelf-arc--big" transform="translate(0 -80)">
      <g className="shelf-arc__glow" filter="url(#shelf-arc-blur)">
        {paths.map((p, i) => (
          <path key={i} d={p.d} strokeWidth={p.main ? 8 : 5} />
        ))}
      </g>
      <g className="shelf-arc__core">
        {paths.map((p, i) => (
          <path key={i} d={p.d} strokeWidth={p.main ? 2 : 1.4} />
        ))}
      </g>
    </g>
  );
}

export interface TeslaCoilProps {
  powered: boolean;
  /** Reduced motion or Calm Frank. */
  still: boolean;
  /** A key that changes for each idle crackle (0 for none). */
  crackleSeq: number;
  /** The sequence number of the wake strike now playing, or 0. */
  wakeSeq: number;
  /** The sequence number of the stitch spark now playing, or 0. */
  sparkSeq: number;
}

export function TeslaCoil({ powered, still, crackleSeq, wakeSeq, sparkSeq }: TeslaCoilProps): JSX.Element {
  return (
    <svg
      className={`shelf-coil${powered ? " shelf-coil--powered" : ""}`}
      viewBox="0 0 84 112"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="shelf-coil-glow-gradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#7df9ff" stopOpacity="0.85" />
          <stop offset="60%" stopColor="#39ff14" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#39ff14" stopOpacity="0" />
        </radialGradient>
        <filter id="shelf-arc-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>
      <circle className="shelf-coil__glow" cx="42" cy="18" r="34" fill="url(#shelf-coil-glow-gradient)" />
      <rect className="shelf-coil__base" x="14" y="104" width="56" height="6" rx="2" />
      <rect className="shelf-coil__base" x="24" y="98" width="36" height="7" rx="2" />
      <polygon className="shelf-coil__column" points="31,98 53,98 46,34 38,34" />
      {[40, 47, 54, 61, 68, 75, 82, 89].map((y, i) => (
        <line key={y} className="shelf-coil__wind" x1={38 - i * 0.7} y1={y} x2={46 + i * 0.7} y2={y} />
      ))}
      <ellipse className="shelf-coil__toroid" cx="42" cy="30" rx="19" ry="6.5" />
      <circle className="shelf-coil__terminal" cx="42" cy="17" r="7" />
      {still ? null : (
        <>
          {crackleSeq > 0 ? (
            <polyline
              key={`c${crackleSeq}`}
              className="shelf-arc shelf-arc--crackle"
              points="42,10 46,4 41,0 46,-6 42,-11"
              fill="none"
            />
          ) : null}
          {wakeSeq > 0 ? <BigArc key={`w${wakeSeq}`} seq={wakeSeq} /> : null}
          {sparkSeq > 0 ? (
            <g key={`s${sparkSeq}`} className="shelf-arc shelf-arc--spark">
              <polyline points="42,10 47,4 43,0 49,-5" fill="none" />
              <circle cx="50" cy="-6" r="1.4" />
              <circle cx="38" cy="2" r="1" />
            </g>
          ) : null}
        </>
      )}
    </svg>
  );
}
