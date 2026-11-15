/**
 * Little Frank's drawn Effects, one set per Reaction (CSS and SVG only).
 *
 * Two layers, both with `pointer-events: none`:
 *  - {@link FrankFx}: a small SVG laid over the body (same 64 x 96 viewBox) with
 *    the needle and thread, sparks, smoke, file, cable, scroll and so on;
 *  - {@link FrankViewportFx}: the two full-viewport Effects of the wake (the
 *    lightning path and the screen flash). They are `position: fixed`, outside
 *    the page flow, and cover no control.
 *
 * Both are keyed by the reaction sequence number so the same reaction twice in
 * a row restarts its animation. They are not rendered at all under reduced
 * motion or Calm Frank (the Specimen decides), so no animation can run then.
 */

import type { JSX } from "react";
import type { ReactionId } from "../../core/frank/reactions";

/** Small sparks around a point: three short strokes, staggered. */
function Sparks({ cx, cy, delay = 0 }: { cx: number; cy: number; delay?: number }): JSX.Element {
  return (
    <g className="fx fx-sparks" style={{ animationDelay: `${delay}ms` }}>
      <polyline points={`${cx - 4},${cy - 2} ${cx - 7},${cy - 6} ${cx - 3},${cy - 7}`} />
      <polyline points={`${cx + 4},${cy - 2} ${cx + 7},${cy - 6} ${cx + 3},${cy - 8}`} />
      <polyline points={`${cx - 2},${cy + 3} ${cx - 5},${cy + 7} ${cx - 1},${cy + 8}`} />
      <polyline points={`${cx + 3},${cy + 3} ${cx + 6},${cy + 6} ${cx + 3},${cy + 9}`} />
    </g>
  );
}

/** The scroll held in his right hand, with three lines. */
function ScrollArt({ className = "" }: { className?: string }): JSX.Element {
  return (
    <g className={`fx fx-scroll ${className}`}>
      <rect x="47" y="48" width="13" height="16" rx="3" className="fx-scroll__paper" />
      <line x1="50" y1="53" x2="57" y2="53" pathLength={1} className="fx-line fx-line-1" />
      <line x1="50" y1="57" x2="57" y2="57" pathLength={1} className="fx-line fx-line-2" />
      <line x1="50" y1="61" x2="54" y2="61" pathLength={1} className="fx-line fx-line-3" />
    </g>
  );
}

/** The flask held in his right hand. */
function FlaskArt({ children }: { children?: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <g className="fx fx-flask">
      <path d="M52 46 L52 52 L47 62 Q46 65 49 65 L58 65 Q61 65 60 62 L55 52 L55 46 Z" className="fx-flask__glass" />
      <line x1="51" y1="46" x2="56" y2="46" className="fx-flask__rim" />
      <path d="M48.5 60 L58.5 60" className="fx-flask__liquid" />
      {children}
    </g>
  );
}

/** What each Reaction draws over the body. */
function body(id: ReactionId): JSX.Element | null {
  switch (id) {
    case "wake":
      return (
        <>
          <Sparks cx={17} cy={28} delay={380} />
          <Sparks cx={47} cy={28} delay={470} />
        </>
      );
    case "catch":
      return (
        <g className="fx fx-file-drop">
          <rect x="39" y="-6" width="9" height="12" rx="1" className="fx-file__paper" />
          <polyline points="44,-6 48,-2 44,-2 44,-6" className="fx-file__fold" />
          <line x1="41" y1="1" x2="46" y2="1" className="fx-file__line" />
          <line x1="41" y1="3.5" x2="45" y2="3.5" className="fx-file__line" />
        </g>
      );
    case "peer":
      return (
        <g className="fx fx-peer-glass">
          <circle cx="36" cy="22" r="6" className="fx-glass__lens" />
          <line x1="40.5" y1="26.5" x2="45" y2="32" className="fx-glass__handle" />
        </g>
      );
    case "thumbs-up":
      return (
        <g className="fx fx-thumb">
          <rect x="49" y="37" width="6.5" height="7" rx="2.2" className="fx-thumb__fist" />
          <rect x="50.8" y="30.5" width="3" height="8" rx="1.5" className="fx-thumb__finger" />
        </g>
      );
    case "sew":
      return (
        <>
          <polyline
            className="fx fx-thread"
            pathLength={1}
            points="20,32 26,38 20,44 26,50 32,44 38,50 44,44 38,38 44,32 38,26"
            fill="none"
          />
          <g className="fx fx-needle">
            <line x1="0" y1="0" x2="8" y2="-3" className="fx-needle__body" />
            <circle cx="8.6" cy="-3.2" r="0.9" className="fx-needle__eye" />
          </g>
          <Sparks cx={32} cy={40} delay={800} />
        </>
      );
    case "bandage":
      return (
        <>
          <Sparks cx={26} cy={40} />
          <Sparks cx={38} cy={50} delay={120} />
        </>
      );
    case "unravel":
      return (
        <g className="fx fx-unravel">
          <path d="M20 54 Q14 60 20 66 Q26 72 18 80" fill="none" pathLength={1} className="fx-curl" />
          <path d="M44 54 Q50 60 44 66 Q38 72 46 80" fill="none" pathLength={1} className="fx-curl fx-curl-2" />
        </g>
      );
    case "head-grab":
      return (
        <g className="fx fx-dizzy">
          <text x="14" y="9" className="fx-star">*</text>
          <text x="46" y="8" className="fx-star fx-star-2">*</text>
        </g>
      );
    case "autopsy-faint":
      return (
        <g className="fx fx-dizzy">
          <text x="12" y="30" className="fx-star">*</text>
          <text x="48" y="30" className="fx-star fx-star-2">*</text>
        </g>
      );
    case "write-scroll":
      return (
        <>
          <ScrollArt className="fx-scroll--write" />
          <line x1="49" y1="52" x2="53" y2="49" className="fx fx-pen" />
        </>
      );
    case "stamp":
      return (
        <g className="fx fx-lift">
          <ScrollArt className="fx-scroll--read" />
          <g className="fx fx-stamp">
            <rect x="48.5" y="55" width="10" height="7" rx="1.2" className="fx-stamp__box" />
            <polyline points="50.5,58.5 52.5,60.5 56.5,56.5" className="fx-stamp__tick" fill="none" />
          </g>
        </g>
      );
    case "smoke":
      return (
        <>
          <FlaskArt />
          <g className="fx fx-smoke">
            <circle cx="53" cy="42" r="3" className="fx-puff fx-puff-1" />
            <circle cx="57" cy="38" r="3.4" className="fx-puff fx-puff-2" />
            <circle cx="52" cy="35" r="3" className="fx-puff fx-puff-3" />
            <circle cx="56" cy="31" r="3.6" className="fx-puff fx-puff-4" />
          </g>
        </>
      );
    case "wave-file":
      return (
        <g className="fx fx-file-away">
          <rect x="57" y="40" width="7" height="9" rx="1" className="fx-file__paper" />
          <line x1="58.5" y1="43" x2="62" y2="43" className="fx-file__line" />
          <line x1="58.5" y1="45.5" x2="61" y2="45.5" className="fx-file__line" />
        </g>
      );
    case "unplug":
      return (
        <g className="fx fx-cable">
          <rect x="58" y="66" width="5" height="9" rx="1" className="fx-socket" />
          <g className="fx-plug-group">
            <path d="M46 66 Q52 62 54 70" fill="none" className="fx-wire" />
            <rect x="52" y="68" width="6" height="5" rx="1" className="fx-plug" />
            <line x1="58" y1="69.5" x2="60" y2="69.5" className="fx-prong" />
            <line x1="58" y1="71.5" x2="60" y2="71.5" className="fx-prong" />
          </g>
          <Sparks cx={59} cy={70} delay={500} />
        </g>
      );
    case "poke-3":
      return (
        <g className="fx fx-brows">
          <line x1="25" y1="12.5" x2="31" y2="14.5" />
          <line x1="39" y1="12.5" x2="33" y2="14.5" />
        </g>
      );
    case "poke-4":
      return (
        <g className="fx fx-brows">
          <line x1="25" y1="12.5" x2="31" y2="14.5" />
          <line x1="39" y1="12.5" x2="33" y2="14.5" />
        </g>
      );
    case "poke-5":
      return (
        <g className="fx fx-steam">
          <circle cx="22" cy="8" r="2.4" className="fx-puff fx-puff-1" />
          <circle cx="42" cy="8" r="2.4" className="fx-puff fx-puff-2" />
          <circle cx="32" cy="2" r="2.8" className="fx-puff fx-puff-3" />
        </g>
      );
    default:
      return null;
  }
}

/** The body-sized Effects of a Reaction. Renders nothing for reactions with none. */
export function FrankFx({ id, seq }: { id: ReactionId | null; seq: number }): JSX.Element | null {
  if (id === null) return null;
  const content = body(id);
  if (content === null) return null;
  return (
    <svg className="specimen__fx" viewBox="0 0 64 96" aria-hidden="true" key={`${id}-${seq}`}>
      {content}
    </svg>
  );
}

/**
 * The full-viewport Effects of the wake: the screen flash and the lightning
 * path from the top of the viewport down onto Frank. Fixed, non-interactive.
 */
export function FrankViewportFx({ id, seq }: { id: ReactionId | null; seq: number }): JSX.Element | null {
  if (id !== "wake") return null;
  return (
    <div key={`wake-${seq}`} aria-hidden="true">
      <div className="frank-flash" data-testid="frank-flash" />
      <svg
        className="frank-lightning"
        data-testid="frank-lightning"
        viewBox="0 0 40 100"
        preserveAspectRatio="none"
      >
        <path
          className="frank-lightning__glow"
          pathLength={1}
          d="M20 0 L11 18 L27 36 L9 58 L26 76 L20 100"
          fill="none"
        />
        <path
          className="frank-lightning__bolt"
          pathLength={1}
          d="M20 0 L11 18 L27 36 L9 58 L26 76 L20 100"
          fill="none"
        />
      </svg>
    </div>
  );
}
