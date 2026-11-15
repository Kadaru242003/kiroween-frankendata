/**
 * The cartoon specimen floating in a jar: simple soft line art in the lab
 * palette, cute and a little spooky, never gory (no blood, no wounds, round
 * shapes). Decorative: it lives inside the jar's aria-hidden art.
 *
 * Three nested groups keep the motions apart, because a CSS transform on a
 * group replaces its transform attribute: the outer one places it in the jar,
 * `shelf-spec` bobs and carries the brightness, `shelf-spec__body` plays the
 * one short hover reaction. All motion is CSS and is switched off for Calm
 * Frank and reduced motion.
 */
import type { CSSProperties, JSX } from "react";
import type { SpecimenId } from "../../core/shelf/shelf-model";

function Art({ kind }: { kind: SpecimenId }): JSX.Element {
  switch (kind) {
    case "hand":
      return (
        <g className="shelf-hand">
          <path className="soft" d="M-5.5 0 H5.5 Q6.5 0 6.5 1 V6 Q6.5 9 3.5 9 H-3.5 Q-6.5 9 -6.5 6 V1 Q-6.5 0 -5.5 0 Z" />
          <path className="thick" d="M-4.5 0 V-6.5 M-1.5 0 V-9 M1.5 0 V-9 M4.5 0 V-6.5" />
          <path className="thick" d="M-6.5 4.5 L-10 1" />
        </g>
      );
    case "bones":
      return (
        <g className="shelf-bones">
          <g className="shelf-bone shelf-bone--1">
            <path d="M-8 -6 L8 6" />
            <circle cx="-8.96" cy="-4.72" r="1.8" />
            <circle cx="-7.04" cy="-7.28" r="1.8" />
            <circle cx="7.04" cy="7.28" r="1.8" />
            <circle cx="8.96" cy="4.72" r="1.8" />
          </g>
          <g className="shelf-bone shelf-bone--2">
            <path d="M-8 6 L8 -6" />
            <circle cx="-8.96" cy="4.72" r="1.8" />
            <circle cx="-7.04" cy="7.28" r="1.8" />
            <circle cx="7.04" cy="-7.28" r="1.8" />
            <circle cx="8.96" cy="-4.72" r="1.8" />
          </g>
          <g className="shelf-bone shelf-bone--3">
            <path d="M-5 9.5 H5" />
            <circle cx="-6" cy="8.3" r="1.6" />
            <circle cx="-6" cy="10.7" r="1.6" />
            <circle cx="6" cy="8.3" r="1.6" />
            <circle cx="6" cy="10.7" r="1.6" />
          </g>
        </g>
      );
    case "arm":
      return (
        <g className="shelf-arm">
          <path className="arm-outline" d="M-10 7 L-2 7 L5 -1" />
          <path className="arm-fill" d="M-10 7 L-2 7 L5 -1" />
          <circle className="soft" cx="7.6" cy="-3.6" r="3.2" />
          <path className="thick" d="M9.2 -6.4 L10.4 -8.4 M10.6 -4.4 L12 -5.6" />
          <path className="stitch" d="M-8.5 7 H-0.5" />
          <path className="stitch" d="M-6.5 4.6 l2 4.8 M-4.5 4.6 l-2 4.8 M-2 4.6 l2 4.8 M0 4.6 l-2 4.8" />
        </g>
      );
    case "heart":
      return (
        <g className="shelf-heart">
          <path className="soft" d="M0 8 C-12 0 -9 -9 -3 -7 C-1.5 -6.5 0 -5 0 -4 C0 -5 1.5 -6.5 3 -7 C9 -9 12 0 0 8 Z" />
          <path d="M-6 -3.5 C-7 -2 -7 -0.5 -6.4 0.6" />
        </g>
      );
    case "brain":
      return (
        <g className="shelf-brain">
          <path
            className="soft"
            d="M-8 2 C-12 -2 -9 -8 -4 -7 C-3 -10 3 -10 4 -7 C9 -8 12 -2 8 2 C9 6 4 8 1.5 6.5 C-0.5 9 -5 8 -5.5 6 C-9 7 -11 4 -8 2 Z"
          />
          <path d="M0 -8 C1 -4 -1 0 0 6 M-6 -2 C-4 -4 -2 -2 -3 0 M5 -3 C3 -1 4 2 6 1" />
          <path className="shelf-brain__spark" d="M-9 -8 l-2 -2.5 l2.5 -0.5 M0 -11 v-3 M9 -8 l2 -2.5 l-2.5 -0.5" />
        </g>
      );
    case "ear":
      return (
        <g className="shelf-ear">
          <path className="soft" d="M0 -10 C-8 -10 -10 -2 -6 3 C-4 6 -4 9 0 9.5 C4 10 6 6 5 3 C9 0 8 -10 0 -10 Z" />
          <path d="M-1 -6 C-5 -5 -4 1 -1 1 C1 1 2 -1 1 -3" />
        </g>
      );
    case "eye":
      return (
        <g className="shelf-eye">
          <path className="soft" d="M-11 0 Q0 -9 11 0 Q0 9 -11 0 Z" />
          <g className="shelf-eye__look">
            <g className="shelf-eye__iris">
              <circle cx="0" cy="0" r="4" />
              <circle className="pupil" cx="0" cy="0" r="1.8" />
              <circle className="shine" cx="1.2" cy="-1.4" r="0.8" />
            </g>
          </g>
        </g>
      );
  }
}

export interface JarSpecimenProps {
  kind: SpecimenId;
  /** SPECIMEN_MIN_BRIGHTNESS (empty jar) to 1 (full jar). */
  brightness: number;
  /** The jar's place on the shelf: offsets the bob so the jars do not move together. */
  phase: number;
  /** The heart beats (its jar is full). */
  beating: boolean;
}

export function JarSpecimen({ kind, brightness, phase, beating }: JarSpecimenProps): JSX.Element {
  return (
    <g transform="translate(28 29.5)" aria-hidden="true">
      <g
        className={`shelf-spec shelf-spec--${kind}${beating ? " shelf-spec--beating" : ""}`}
        style={{ "--bright": brightness, "--delay": `${(-phase * 0.9).toFixed(1)}s` } as CSSProperties}
        data-specimen={kind}
      >
        <g className="shelf-spec__body">
          <Art kind={kind} />
        </g>
      </g>
    </g>
  );
}
