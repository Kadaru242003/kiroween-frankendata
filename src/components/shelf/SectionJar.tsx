/**
 * One section jar (SVG) with its name as text under it. The liquid level shows
 * how far that step has got: empty, half or full. It is a real button that
 * scrolls to the section (and the owner moves focus to its heading); a tooltip
 * to the left gives the section name and a one-line status. A jar that is
 * draining (its section went away) is decorative, aria-hidden and ignores the
 * pointer.
 */
import { useId, type CSSProperties, type JSX, type PointerEvent } from "react";
import { heartBeats, type SectionJar as SectionJarModel } from "../../core/shelf/shelf-model";
import { JarSpecimen } from "./JarSpecimen";

const BODY = "M12 8 H44 V11 Q48 12.5 48 17 V43 Q48 48 43 48 H13 Q8 48 8 43 V17 Q8 12.5 12 11 Z";
const INNER_TOP = 12;
const INNER_BOTTOM = 47;
const BUBBLE_XS = [19, 28, 37];

function Art({ jar, still, phase }: { jar: SectionJarModel; still: boolean; phase: number }): JSX.Element {
  const clipId = `jar-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const inner = INNER_BOTTOM - INNER_TOP;
  return (
    <svg className="shelf-jar__art" viewBox="0 0 56 54" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clipId}>
          <path d={BODY} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {/* The liquid is always full height; its level is a vertical scale, so it can rise smoothly. */}
        <rect
          className="shelf-jar__liquid"
          x="8"
          y={INNER_TOP}
          width="40"
          height={inner + 2}
          style={{ "--fill": jar.fill } as CSSProperties}
        />
        {still || jar.fill === 0
          ? null
          : BUBBLE_XS.map((x, i) => (
              <circle
                key={x}
                className="shelf-jar__bubble"
                cx={x}
                cy={INNER_BOTTOM - 3}
                r={1.1 + (i % 2) * 0.5}
                style={
                  {
                    "--rise": `${Math.max(5, inner * jar.fill - 6).toFixed(1)}px`,
                    animationDelay: `${i * 700}ms`,
                  } as CSSProperties
                }
              />
            ))}
      </g>
      <JarSpecimen
        kind={jar.specimen}
        brightness={jar.brightness}
        phase={phase}
        beating={jar.id === "result" && heartBeats(jar.progress) && !still}
      />
      <path className="shelf-jar__glass" d={BODY} />
      <rect className="shelf-jar__lid" x="13" y="2" width="30" height="6" rx="2" />
      <path className="shelf-jar__shine" d="M13 20 V40" />
    </svg>
  );
}

export interface SectionJarProps {
  jar: SectionJarModel;
  /** The jar of the section now in view. */
  active: boolean;
  /** The jar is draining: its liquid falls, then it fades. Not interactive. */
  leaving: boolean;
  /** The jar's place on the shelf (offsets the specimen's bob). */
  phase: number;
  /** Reduced motion or Calm Frank: static art (no bubbles, no motion). */
  still: boolean;
  onGo: (id: SectionJarModel["id"]) => void;
}

export function SectionJar({ jar, active, leaving, phase, still, onGo }: SectionJarProps): JSX.Element {
  const tipId = `shelf-tip-${jar.id}`;
  // The eye follows the cursor while it is over the jar (a small, clamped offset).
  const look = (e: PointerEvent<HTMLButtonElement>) => {
    if (still) return;
    const box = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - (box.left + box.width / 2)) / 12;
    const dy = (e.clientY - (box.top + box.height * 0.4)) / 12;
    e.currentTarget.style.setProperty("--look-x", `${Math.max(-3, Math.min(3, dx)).toFixed(1)}px`);
    e.currentTarget.style.setProperty("--look-y", `${Math.max(-2, Math.min(2, dy)).toFixed(1)}px`);
  };
  if (leaving) {
    return (
      <li className="shelf-item shelf-item--leaving" aria-hidden="true">
        <div className="shelf-jar" data-progress={jar.progress}>
          <Art jar={jar} still={still} phase={phase} />
          <span className="shelf-jar__text">{jar.label}</span>
        </div>
      </li>
    );
  }
  return (
    <li className="shelf-item">
      <button
        type="button"
        className={`shelf-jar${active ? " shelf-jar--active" : ""}`}
        aria-label={jar.ariaLabel}
        aria-current={active ? "true" : undefined}
        aria-describedby={tipId}
        data-section={jar.id}
        data-progress={jar.progress}
        onClick={() => onGo(jar.id)}
        onPointerMove={look}
      >
        <Art jar={jar} still={still} phase={phase} />
        <span className="shelf-jar__text">{jar.label}</span>
      </button>
      <span role="tooltip" id={tipId} className="shelf-tip">
        {jar.status}
      </span>
    </li>
  );
}
