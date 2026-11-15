/**
 * One specimen jar (SVG): green liquid with rising bubbles, a paper label with
 * the table name (cut with an ellipsis; the full name is the tooltip) and the
 * row count. A stitched result's label has stitched seams. A table jar is a real
 * button that scrolls its card into view; the "+N" jar and a draining jar are
 * decorative (aria-hidden, no pointer).
 */
import { useId, type CSSProperties, type JSX } from "react";
import { rowsText, type Jar } from "../../core/shelf/shelf-model";

const BODY = "M18 10 H66 V14 Q71 16 71 22 V55 Q71 61 65 61 H19 Q13 61 13 55 V22 Q13 16 18 14 Z";
/** The inside of the glass: where the liquid can be. */
const INNER_TOP = 16;
const INNER_BOTTOM = 59;
const BUBBLE_XS = [26, 41, 55];

function Art({ jar, still }: { jar: Jar; still: boolean }): JSX.Element {
  const clipId = `jar-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const stitched = jar.kind === "stitched";
  const height = (INNER_BOTTOM - INNER_TOP) * jar.level;
  const top = INNER_BOTTOM - height;
  return (
    <svg className="shelf-jar__art" viewBox="0 0 84 66" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clipId}>
          <path d={BODY} />
        </clipPath>
      </defs>
      <rect className="shelf-jar__plank" x="2" y="62" width="80" height="4" rx="1" />
      {jar.kind === "more" ? (
        <>
          <path className="shelf-jar__glass" d={BODY} />
          <rect className="shelf-jar__lid" x="20" y="3" width="44" height="7" rx="2" />
          <text className="shelf-jar__more" x="42" y="44" textAnchor="middle">
            {jar.label}
          </text>
        </>
      ) : (
        <>
          <g clipPath={`url(#${clipId})`}>
            <rect className="shelf-jar__liquid" x="13" y={top} width="58" height={height + 4} />
            <rect className="shelf-jar__surface" x="13" y={top} width="58" height="2" />
            {still
              ? null
              : BUBBLE_XS.map((x, i) => (
                  <circle
                    key={x}
                    className="shelf-jar__bubble"
                    cx={x}
                    cy={INNER_BOTTOM - 3}
                    r={1.3 + (i % 2) * 0.5}
                    style={
                      {
                        "--rise": `${Math.max(6, height - 6).toFixed(1)}px`,
                        animationDelay: `${i * 700}ms`,
                      } as CSSProperties
                    }
                  />
                ))}
          </g>
          <path className="shelf-jar__glass" d={BODY} />
          <rect className="shelf-jar__lid" x="20" y="3" width="44" height="7" rx="2" />
          <path className="shelf-jar__shine" d="M19 22 V50" />
          {stitched ? <path className="shelf-jar__seam-body" d="M13 30 L22 25 L31 31 L40 25 L49 31 L58 25 L71 30" /> : null}
          <g className={`shelf-jar__label${stitched ? " shelf-jar__label--stitched" : ""}`}>
            <rect className="shelf-jar__paper" x="16" y="30" width="52" height="24" rx="1.5" />
            {stitched ? (
              <>
                <rect className="shelf-jar__stitch" x="18" y="32" width="48" height="20" rx="1" />
                <path className="shelf-jar__cross" d="M15 29 l4 4 M19 29 l-4 4 M65 51 l4 4 M69 51 l-4 4" />
              </>
            ) : null}
            <text className="shelf-jar__name" x="42" y="40.5" textAnchor="middle">
              {jar.label}
            </text>
            <text className="shelf-jar__rows" x="42" y="49" textAnchor="middle">
              {rowsText(jar.rowCount)}
            </text>
          </g>
        </>
      )}
    </svg>
  );
}

export interface SpecimenJarProps {
  jar: Jar;
  /** The jar is draining: its liquid falls, then it fades. Not interactive. */
  leaving: boolean;
  /** Reduced motion or Calm Frank: static art (no bubbles). */
  still: boolean;
  onGo: (name: string) => void;
}

export function SpecimenJar({ jar, leaving, still, onGo }: SpecimenJarProps): JSX.Element {
  const className = [
    "shelf-jar",
    `shelf-jar--${jar.kind}`,
    leaving ? "shelf-jar--leaving" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (jar.kind === "more" || leaving || jar.ariaLabel === null) {
    return (
      <div className={className} aria-hidden="true">
        <Art jar={jar} still={still} />
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      aria-label={jar.ariaLabel}
      title={`${jar.name} (${rowsText(jar.rowCount)})`}
      onClick={() => onGo(jar.name)}
    >
      <Art jar={jar} still={still} />
    </button>
  );
}
