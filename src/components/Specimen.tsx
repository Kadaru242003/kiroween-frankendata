/**
 * Specimen (shown to users as "Little Frank") — a presentational lab mascot
 * fixed in the bottom-left corner.
 *
 * Little Frank is a tiny creature built from spreadsheet cells, standing on a
 * simple SVG operating slab. It draws no movie monster: no flat head, no neck
 * bolts, no green-skinned humanoid face, just cells, stitches, an electrode,
 * and the occasional spark.
 *
 * It is decorative but interactive: the whole creature is wrapped in a real
 * <button aria-label="Poke Little Frank"> so it is keyboard reachable with a
 * visible focus ring, while the slab and body SVGs are aria-hidden. It changes
 * no app state: all story states come from read-only props, and poking only
 * plays a short local animation.
 *
 * Story states (resting poses) and short reactions (about 2s on a transition,
 * detected with previous-value refs) are driven from props. Accessories are
 * small SVG pieces layered on the body that persist while their state holds.
 *
 * Fixed bottom-left, about 140px tall, below the sticky action bar z-index,
 * hidden below 640px. Under prefers-reduced-motion there is no walking,
 * swinging, or timed reaction animation: it swaps the static pose and shows the
 * bubble text only.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import "./Specimen.css";

export interface SpecimenProps {
  /** Number of loaded tables. 0 means asleep/dormant. */
  tableCount: number;
  /** Stitch proposals are currently showing (wears goggles, scans). */
  proposalsShowing: boolean;
  /** Number of approved proposals (an increase triggers a thumbs-up). */
  approvedCount: number;
  /** A stitched result exists (bandages, patch, extra cell). */
  stitched: boolean;
  /** An Ask the Lab request is pending (taps chin, three-dot bubble). */
  askPending: boolean;
  /** An Ask the Lab result is shown (holds a bar-chart sign). */
  askResult: boolean;
  /** An intake error exists (plaster, dizzy stars, head shake). */
  intakeError: boolean;
  /**
   * An Autopsy case file is open: Little Frank holds a magnifying glass. It
   * uses the same hand as the chart sign and clipboard, so those are hidden
   * while it shows. Optional, default false.
   */
  autopsyOpen?: boolean;
  /**
   * A recipe has been applied: Little Frank holds a small recipe scroll. Same
   * hand as the other held items; priority is magnifying glass, then scroll,
   * then chart sign, then clipboard. Optional, default false.
   */
  recipeApplied?: boolean;
}

/** A transient reaction the Specimen plays for a short time, then clears. */
type Reaction =
  | "alive"
  | "hmm"
  | "approved"
  | "stitched"
  | "ugh"
  | "reset"
  | "poke-jolt"
  | "poke-wave"
  | "poke-spin"
  | "poke-giggle"
  | "poke-stop"
  | "poke-sleep"
  | "hint";

const REACTION_BUBBLE: Partial<Record<Reaction, string>> = {
  alive: "It's alive!",
  hmm: "Hmm...",
  approved: "Approved!",
  stitched: "Stitched!",
  ugh: "Ugh!",
  "poke-jolt": "Bzzt!",
  "poke-wave": "Hi!",
  "poke-giggle": "Hehe",
  "poke-stop": "Stop poking me!",
  "poke-sleep": "5 more minutes...",
  hint: "Poke me!",
};

const POKE_REACTIONS: Reaction[] = [
  "poke-jolt",
  "poke-wave",
  "poke-spin",
  "poke-giggle",
];

/**
 * Whether an Ask the Lab answer is currently on screen. The ask store keeps the
 * latest answer in `outcome` (set by both typed questions and starter chips),
 * and the panel hides it while a new question is `loading`, so the mascot only
 * holds the chart sign when there is an `ok` outcome AND nothing is pending.
 */
export function isAskResultShown(
  outcome: { kind: string } | null,
  loading: boolean
): boolean {
  return !loading && outcome !== null && outcome.kind === "ok";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function Specimen(props: SpecimenProps): JSX.Element {
  const {
    tableCount,
    proposalsShowing,
    approvedCount,
    stitched,
    askPending,
    askResult,
    intakeError,
  } = props;
  const autopsyOpen = props.autopsyOpen ?? false;
  const recipeApplied = props.recipeApplied ?? false;

  const reduced = prefersReducedMotion();
  const awake = tableCount > 0;

  const [reaction, setReaction] = useState<Reaction | null>(null);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const play = useCallback((next: Reaction, ms: number) => {
    setReaction(next);
    if (reactionTimer.current !== null) {
      clearTimeout(reactionTimer.current);
    }
    reactionTimer.current = setTimeout(() => setReaction(null), ms);
  }, []);

  useEffect(() => {
    return () => {
      if (reactionTimer.current !== null) {
        clearTimeout(reactionTimer.current);
      }
    };
  }, []);

  // Previous-value refs so we can detect transitions.
  const prev = useRef({
    tableCount,
    proposalsShowing,
    approvedCount,
    stitched,
    intakeError,
  });

  useEffect(() => {
    const p = prev.current;

    // b. 0 -> 1+: comes alive. i. 1+ -> 0: reset/flop.
    if (p.tableCount === 0 && tableCount > 0) {
      play("alive", 2000);
    } else if (p.tableCount > 0 && tableCount === 0) {
      play("reset", 2000);
    } else if (stitched && !p.stitched) {
      // e. stitched result appeared.
      play("stitched", 2000);
    } else if (intakeError && !p.intakeError) {
      // h. intake error appeared.
      play("ugh", 2000);
    } else if (approvedCount > p.approvedCount) {
      // d. approved count increased.
      play("approved", 2000);
    } else if (proposalsShowing && !p.proposalsShowing) {
      // c. proposals started showing.
      play("hmm", 2000);
    }

    prev.current = {
      tableCount,
      proposalsShowing,
      approvedCount,
      stitched,
      intakeError,
    };
  }, [tableCount, proposalsShowing, approvedCount, stitched, intakeError, play]);

  // Poke handling: random reaction, never the same twice in a row; a 5-in-3s
  // burst triggers the "stop poking me" easter egg; a poke while asleep stirs.
  const lastPoke = useRef<Reaction | null>(null);
  const pokeTimes = useRef<number[]>([]);
  const pokedOnce = useRef(false);

  const handlePoke = useCallback(() => {
    pokedOnce.current = true;
    const now = Date.now();
    pokeTimes.current = pokeTimes.current.filter((t) => now - t < 3000);
    pokeTimes.current.push(now);

    if (!awake) {
      play("poke-sleep", 1600);
      return;
    }
    if (pokeTimes.current.length >= 5) {
      pokeTimes.current = [];
      play("poke-stop", 2000);
      return;
    }
    let next = POKE_REACTIONS[Math.floor(Math.random() * POKE_REACTIONS.length)];
    if (next === lastPoke.current) {
      const idx =
        (POKE_REACTIONS.indexOf(next) + 1) % POKE_REACTIONS.length;
      next = POKE_REACTIONS[idx];
    }
    lastPoke.current = next;
    play(next, 1200);
  }, [awake, play]);

  // Discoverability: once per page load, if awake and not poked within 8s of
  // waking, show "Poke me!" for 3s, then never again this session.
  const hintShown = useRef(false);
  useEffect(() => {
    if (!awake || reduced || hintShown.current) {
      return;
    }
    const timer = setTimeout(() => {
      if (!pokedOnce.current && !hintShown.current) {
        hintShown.current = true;
        play("hint", 3000);
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [awake, reduced, play]);

  // Resting state class (pose that holds while the state holds).
  const stateClass = !awake
    ? "specimen--asleep"
    : stitched
      ? "specimen--alive"
      : "specimen--awake";

  const bubbleText = reaction ? REACTION_BUBBLE[reaction] ?? "" : "";
  const showDots = askPending && !reaction;

  const className = [
    "specimen",
    stateClass,
    reaction ? `specimen--react-${reaction}` : "",
    reduced ? "specimen--reduced" : "",
    askPending ? "specimen--thinking" : "",
    autopsyOpen ? "specimen--investigating" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Accessory flags that persist while their state holds.
  const wearGoggles = proposalsShowing && !askResult;
  // The magnifying glass, chart sign, and clipboard share the same hand, so
  // only one shows at a time, with the magnifying glass taking priority.
  const holdScroll = recipeApplied && !autopsyOpen;
  const holdChart = askResult && !autopsyOpen && !holdScroll;
  const holdClipboard =
    awake &&
    approvedCount > 0 &&
    !stitched &&
    !holdChart &&
    !autopsyOpen &&
    !holdScroll;

  return (
    <div className="specimen-layer">
      <button
        type="button"
        className="specimen-button"
        aria-label="Poke Little Frank"
        onClick={handlePoke}
      >
        <span className={className} aria-hidden="true">
          {/* Speech bubble (reaction text) / three-dot thinking bubble. */}
          {bubbleText ? (
            <span className="specimen__bubble">{bubbleText}</span>
          ) : null}
          {showDots ? (
            <span className="specimen__bubble specimen__bubble--dots">
              <i /><i /><i />
            </span>
          ) : null}

          {/* Zzz when asleep. */}
          {!awake ? <span className="specimen__zzz">Zzz</span> : null}

          {/* Lightning bolt for the alive / poke-jolt reactions. */}
          <svg className="specimen__bolt" viewBox="0 0 24 44">
            <polyline
              className="specimen__bolt-path"
              points="14,0 6,20 12,20 4,44 20,16 13,16 18,0"
              fill="none"
            />
          </svg>

          {/* The creature + slab. */}
          <svg className="specimen__body" viewBox="0 0 64 96">
            {/* Operating slab. */}
            <rect className="specimen__slab" x="2" y="84" width="60" height="9" rx="2" />
            <line className="specimen__slab-leg" x1="10" y1="93" x2="10" y2="96" />
            <line className="specimen__slab-leg" x1="54" y1="93" x2="54" y2="96" />

            {/* Arms (one a different color), joined by cross-stitches. */}
            <rect className="specimen__arm specimen__arm--left" x="4" y="52" width="12" height="6" rx="3" />
            <rect className="specimen__arm specimen__arm--right" x="48" y="52" width="12" height="6" rx="3" />
            {/* Legs. */}
            {/* Legs run from under the body (y 64) down onto the slab (y 84)
                so there is no gap between the grid and the feet. */}
            <rect className="specimen__leg specimen__leg--left" x="22" y="64" width="7" height="22" rx="3" />
            <rect className="specimen__leg specimen__leg--right" x="35" y="64" width="7" height="22" rx="3" />

            {/* Electrode on top of the head (sparks when awake). */}
            <line className="specimen__electrode" x1="32" y1="6" x2="32" y2="1" />
            <circle className="specimen__electrode-tip" cx="32" cy="1" r="1.6" />
            <polyline className="specimen__electrode-spark" points="32,1 38,4 34,7 42,9" fill="none" />

            {/* Head: a single cell with two mismatched eyes. */}
            <rect className="specimen__head" x="22" y="8" width="20" height="18" rx="2" />
            <circle className="specimen__eye specimen__eye--l" cx="29" cy="17" r="2.6" />
            <rect className="specimen__eye specimen__eye--r" x="35" y="14.5" width="5" height="5" rx="1.2" />
            {/* Closed lids (asleep) and X eyes (reset) are toggled via CSS. */}
            <line className="specimen__lid specimen__lid--l" x1="26" y1="17" x2="32" y2="17" />
            <line className="specimen__lid specimen__lid--r" x1="35" y1="17" x2="40" y2="17" />

            {/* Body: a 3x3 grid of table cells. */}
            <g className="specimen__grid">
              <rect x="18" y="26" width="28" height="42" rx="2" className="specimen__grid-frame" />
              <line x1="27.3" y1="26" x2="27.3" y2="68" />
              <line x1="36.6" y1="26" x2="36.6" y2="68" />
              <line x1="18" y1="40" x2="46" y2="40" />
              <line x1="18" y1="54" x2="46" y2="54" />
            </g>

            {/* Cross-stitches joining the limbs to the body. */}
            <g className="specimen__stitches">
              <line x1="14" y1="53" x2="18" y2="57" />
              <line x1="18" y1="53" x2="14" y2="57" />
              <line x1="46" y1="53" x2="50" y2="57" />
              <line x1="50" y1="53" x2="46" y2="57" />
              {/* Hip stitches joining each leg to the body. */}
              <line x1="22" y1="68" x2="29" y2="72" />
              <line x1="29" y1="68" x2="22" y2="72" />
              <line x1="35" y1="68" x2="42" y2="72" />
              <line x1="42" y1="68" x2="35" y2="72" />
            </g>

            {/* Goggles (proposals showing). */}
            {wearGoggles ? (
              <g className="specimen__goggles">
                <circle cx="29" cy="17" r="4" />
                <circle cx="37" cy="17" r="4" />
                <line x1="33" y1="17" x2="33" y2="17" />
              </g>
            ) : null}

            {/* Alive accessories: bandages, body patch, extra sewn-on cell. */}
            {stitched ? (
              <g className="specimen__alive-kit">
                <rect className="specimen__bandage" x="22" y="11" width="20" height="4" rx="1" />
                <rect className="specimen__bandage" x="4" y="53" width="12" height="4" rx="1" />
                <rect className="specimen__patch" x="30" y="44" width="10" height="10" rx="1" />
                <rect className="specimen__extra-cell" x="46" y="40" width="9" height="12" rx="1" />
              </g>
            ) : null}

            {/* Magnifying glass held in the right hand while an Autopsy is open. */}
            {autopsyOpen ? (
              <g className="specimen__magnifier">
                <circle cx="56" cy="44" r="6.5" />
                <line x1="52" y1="49" x2="49" y2="55" />
              </g>
            ) : null}

            {/* Recipe scroll held after a recipe is applied (decorative). */}
            {holdScroll ? (
              <g className="specimen__scroll" aria-hidden="true">
                <rect x="47" y="48" width="13" height="16" rx="3" />
                <line x1="50" y1="53" x2="57" y2="53" />
                <line x1="50" y1="57" x2="57" y2="57" />
                <line x1="50" y1="61" x2="54" y2="61" />
              </g>
            ) : null}
            {/* Clipboard with a check (approved count > 0). */}
            {holdClipboard ? (
              <g className="specimen__clipboard">
                <rect x="47" y="50" width="12" height="15" rx="1" />
                <polyline points="50,57 53,61 57,53" fill="none" />
              </g>
            ) : null}

            {/* Intake error: plaster + dizzy stars. */}
            {intakeError ? (
              <g className="specimen__ouch">
                <rect className="specimen__plaster" x="24" y="9" width="8" height="3" rx="1" transform="rotate(-20 28 10)" />
                <text className="specimen__star" x="18" y="8">*</text>
                <text className="specimen__star" x="44" y="10">*</text>
              </g>
            ) : null}
          </svg>

          {/*
            Bar-chart sign held up while an Ask result is shown. It is drawn
            AFTER the body SVG (and given a z-index in CSS) because the body has
            an animated transform, which creates a stacking context that would
            otherwise paint over an earlier sibling and hide the sign.
          */}
          {holdChart ? (
            <svg className="specimen__sign" viewBox="0 0 24 18">
              <rect className="specimen__sign-bg" x="0.5" y="0.5" width="23" height="17" rx="2" />
              <rect className="specimen__bar" x="4" y="9" width="3" height="6" />
              <rect className="specimen__bar" x="9" y="5" width="3" height="10" />
              <rect className="specimen__bar" x="14" y="7" width="3" height="8" />
            </svg>
          ) : null}
        </span>
      </button>
    </div>
  );
}

export default Specimen;
