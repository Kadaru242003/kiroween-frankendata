/**
 * Specimen (shown to users as "Little Frank"): a presentational lab mascot fixed
 * in the bottom-left corner.
 *
 * He is the creature of Mary Shelley's novel, drawn as a patchwork of
 * mismatched table cells on a simple SVG operating slab: patches in greens and
 * grays, lighter stitched seams, one eye bigger than the other, small electrode
 * nubs, a satchel with a book, and a coat sleeve a little too long. The whole
 * creature is a real `<button aria-label="Poke Little Frank">` (tapping or
 * Enter or Space pokes him); a small "?" button by his head
 * (`aria-label="Ask Little Frank"`) opens the guide. The art is aria-hidden.
 *
 * He draws what he is told and decides nothing:
 *  - held Poses come from state props (asleep, awake, bandaged, chart sign,
 *    stethoscope and clipboard, bubbling flask, recipe scroll);
 *  - one transient Reaction at a time comes from the pure reaction queue
 *    (`reaction`, `reactionSeq`) with its speech bubble (`bubble`).
 *
 * Every Effect has `pointer-events: none`. Under reduced motion or Calm Frank
 * (`specimen--still`) no animation runs and the Effects are not rendered: only
 * the static pose of the reaction (a class) and the bubble text show. His eyes
 * follow the cursor when it is near, through one throttled pointer listener.
 * Fixed bottom-left, about 140px tall, hidden below 640px.
 */

import {
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
  type Ref,
} from "react";
import { FRANK_EYE_RANGE_PX } from "../core/frank/constants";
import type { Reaction } from "../core/frank/reactions";
import { FrankFx, FrankViewportFx } from "./frank/FrankFx";
import "./Specimen.css";

export interface SpecimenProps {
  /** Number of loaded tables. 0 means asleep/dormant. */
  tableCount: number;
  /** Stitch proposals are currently showing (wears goggles). */
  proposalsShowing: boolean;
  /** Number of approved proposals (shows the approval clipboard). */
  approvedCount: number;
  /** A stitched result exists (bandages, patch, extra cell). */
  stitched: boolean;
  /** An Ask the Lab request is pending (holds a bubbling flask). */
  askPending: boolean;
  /** An Ask the Lab result is shown (holds a bar-chart sign). */
  askResult: boolean;
  /** An intake error exists (plaster, dizzy stars). */
  intakeError: boolean;
  /** An Autopsy case file is open (stethoscope and clipboard). Default false. */
  autopsyOpen?: boolean;
  /** A recipe has been applied (holds a recipe scroll). Default false. */
  recipeApplied?: boolean;
  /** The Reaction playing now, or null. */
  reaction?: Reaction | null;
  /** Bumps when a Reaction starts, so the same one twice restarts. */
  reactionSeq?: number;
  /** The speech-bubble text, or null. */
  bubble?: string | null;
  /** No activity for a while: he sleeps. */
  idle?: boolean;
  /** Calm Frank: no animations, poses and bubble text stay. */
  calm?: boolean;
  /** Override for reduced motion (default: the media query). */
  reducedMotion?: boolean;
  /** The guide panel is open (his button reports it; the bubble steps aside). */
  guideOpen?: boolean;
  /** Tapping or clicking him pokes him. */
  onPoke?: () => void;
  /** The "?" button asks the owner to toggle the guide. */
  onToggleGuide?: () => void;
  /** The "?" button, so the guide can return focus to it. */
  buttonRef?: Ref<HTMLButtonElement>;
  /** The guide panel, rendered inside his layer. */
  children?: ReactNode;
}

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

/** Whether the user asked the system for reduced motion. */
export function prefersReducedMotion(): boolean {
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
    reaction = null,
    reactionSeq = 0,
    bubble = null,
    idle = false,
    calm = false,
    guideOpen = false,
    onPoke,
    onToggleGuide,
    buttonRef,
    children,
  } = props;
  const autopsyOpen = props.autopsyOpen ?? false;
  const recipeApplied = props.recipeApplied ?? false;
  const reduced = props.reducedMotion ?? prefersReducedMotion();
  // No motion at all: reduced motion or Calm Frank. Poses and fades remain.
  const still = reduced || calm;
  const awake = tableCount > 0 && !idle;
  const hasTables = tableCount > 0;

  const rootRef = useRef<HTMLSpanElement>(null);

  // Eyes follow the cursor when it is near him. One passive pointer listener,
  // throttled with requestAnimationFrame; sets two CSS variables, no re-render.
  const followEyes = awake && !still;
  useEffect(() => {
    const el = rootRef.current;
    if (!followEyes || el === null) return;
    let raf = 0;
    let pending = false;
    let lastX = 0;
    let lastY = 0;
    const apply = () => {
      raf = 0;
      pending = false;
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width * 0.5;
      const cy = box.top + box.height * 0.18;
      const dx = lastX - cx;
      const dy = lastY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > FRANK_EYE_RANGE_PX || dist === 0) {
        el.style.setProperty("--eye-x", "0px");
        el.style.setProperty("--eye-y", "0px");
        return;
      }
      const reach = Math.min(1, dist / 90) * 1.4;
      el.style.setProperty("--eye-x", `${((dx / dist) * reach).toFixed(2)}px`);
      el.style.setProperty("--eye-y", `${((dy / dist) * reach).toFixed(2)}px`);
    };
    const onMove = (e: PointerEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (pending) return;
      pending = true;
      const id = requestAnimationFrame(apply);
      if (pending) raf = id;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf !== 0) cancelAnimationFrame(raf);
      el.style.removeProperty("--eye-x");
      el.style.removeProperty("--eye-y");
    };
  }, [followEyes]);

  // Resting pose (holds while the state holds).
  const stateClass = !awake
    ? "specimen--asleep"
    : stitched
      ? "specimen--alive"
      : "specimen--awake";

  const reactionId = reaction?.id ?? null;
  const className = [
    "specimen",
    stateClass,
    reactionId ? `specimen--react-${reactionId}` : "",
    still ? "specimen--still" : "",
    reduced ? "specimen--reduced" : "",
    askPending ? "specimen--thinking" : "",
    autopsyOpen ? "specimen--investigating" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Held items share one hand: autopsy gear, then the flask, then the scroll,
  // then the chart sign, then the approval clipboard.
  const holdFlask = askPending && !autopsyOpen;
  const holdScroll = recipeApplied && !autopsyOpen && !holdFlask;
  const holdChart = askResult && !autopsyOpen && !holdScroll && !holdFlask;
  const holdClipboard =
    hasTables &&
    approvedCount > 0 &&
    !stitched &&
    !holdChart &&
    !autopsyOpen &&
    !holdScroll &&
    !holdFlask;
  const wearGoggles = proposalsShowing && !askResult;
  const showBubble = bubble !== null && !guideOpen;

  const effectsOn = !still;

  return (
    <div className={`specimen-layer${guideOpen ? " specimen-layer--open" : ""}`}>
      {effectsOn ? <FrankViewportFx id={reactionId} seq={reactionSeq} anchor={rootRef} /> : null}
      <button
        type="button"
        className="specimen-button"
        aria-label="Poke Little Frank"
        onClick={onPoke}
      >
        <span
          ref={rootRef}
          className={className}
          aria-hidden="true"
          data-reaction={reactionId ?? undefined}
        >
          {/* Speech bubble (reaction text). */}
          {showBubble ? <span className="specimen__bubble">{bubble}</span> : null}

          {/* Zzz when asleep. */}
          {!awake ? <span className="specimen__zzz">Zzz</span> : null}

          {/* The creature + slab. */}
          <svg className="specimen__body" viewBox="0 0 64 96">
            {/* Operating slab. */}
            <rect className="specimen__slab" x="2" y="84" width="60" height="9" rx="2" />
            <line className="specimen__slab-leg" x1="10" y1="93" x2="10" y2="96" />
            <line className="specimen__slab-leg" x1="54" y1="93" x2="54" y2="96" />

            {/* Legs run from under the body (y 64) down onto the slab (y 84).
                Each is two mismatched patches with a seam between them. */}
            <rect className="specimen__leg specimen__leg--left pc pc--2" x="22" y="64" width="7" height="22" rx="3" />
            <rect className="pc pc--4" x="22.7" y="76" width="5.6" height="9.3" rx="2" />
            <line className="specimen__seam" x1="22.7" y1="76" x2="28.3" y2="76" />
            <rect className="specimen__leg specimen__leg--right pc pc--3" x="35" y="64" width="7" height="22" rx="3" />
            <rect className="pc pc--1" x="35.7" y="72" width="5.6" height="13.3" rx="2" />
            <line className="specimen__seam" x1="35.7" y1="72" x2="41.3" y2="72" />

            {/* Left arm: two patches and a hand. */}
            <g className="specimen__arm specimen__arm--left">
              <rect className="specimen__limb pc pc--3" x="4" y="52" width="13" height="6" rx="3" />
              <rect className="pc pc--1" x="10.5" y="52.6" width="5.6" height="4.8" rx="2" />
              <line className="specimen__seam" x1="10.5" y1="52.6" x2="10.5" y2="57.4" />
              <circle className="specimen__hand" cx="4.6" cy="55" r="2.3" />
            </g>
            {/* Right arm: a coat sleeve a little too long, the fingertips just showing. */}
            <g className="specimen__arm specimen__arm--right">
              <rect className="specimen__sleeve" x="47" y="51" width="14" height="8" rx="3.5" />
              <line className="specimen__cuff" x1="57.4" y1="51.6" x2="57.4" y2="58.4" />
              <rect className="specimen__hand" x="60.4" y="54" width="3" height="3.4" rx="1.2" />
            </g>

            {/* Neck bolts (small electrode nubs). */}
            <circle className="specimen__neckbolt" cx="17.5" cy="28" r="1.8" />
            <circle className="specimen__neckbolt" cx="46.5" cy="28" r="1.8" />

            {/* Electrode nubs at the temples and a short one on top (sparks when awake). */}
            <rect className="specimen__nub" x="19.4" y="14.2" width="3.4" height="5" rx="1.6" />
            <rect className="specimen__nub" x="41.2" y="14.2" width="3.4" height="5" rx="1.6" />
            <line className="specimen__electrode" x1="32" y1="8" x2="32" y2="3.2" />
            <circle className="specimen__electrode-tip" cx="32" cy="3" r="1.5" />
            <polyline className="specimen__electrode-spark" points="32,3 38,5 34,8 42,10" fill="none" />

            {/* Head group: a patchwork head, one eye bigger than the other. */}
            <g className="specimen__headg">
              <rect className="specimen__head pc pc--2" x="22" y="8" width="20" height="18" rx="3" />
              <rect className="pc pc--3" x="33" y="8.8" width="8.4" height="10" rx="2" />
              <path className="specimen__seam" d="M33 8.8 V18.8 H41.4" fill="none" />
              <circle className="specimen__eye specimen__eye--l" cx="28.5" cy="17" r="3.3" />
              <circle className="specimen__eye specimen__eye--r" cx="37.2" cy="17.8" r="2.2" />
              {/* Closed lids (asleep, fainted) and X eyes (reset). */}
              <line className="specimen__lid specimen__lid--l" x1="25" y1="17" x2="32" y2="17" />
              <line className="specimen__lid specimen__lid--r" x1="34.6" y1="17.8" x2="39.8" y2="17.8" />
              <path className="specimen__mouth" d="M30 22.6 Q33.5 23.8 37 22.4" fill="none" />
              {/* Static poses shown by a reaction class: smile, surgeon mask, pumpkin. */}
              <path className="specimen__smile" d="M27.5 21.5 Q32 26.5 36.5 21.5" fill="none" />
              <g className="specimen__mask">
                <rect x="24" y="19.5" width="16" height="6.5" rx="1.5" />
                <line x1="24" y1="21" x2="22" y2="19" />
                <line x1="40" y1="21" x2="42" y2="19" />
              </g>
              <g className="specimen__pumpkin">
                <ellipse cx="32" cy="5" rx="8" ry="5.5" />
                <line x1="32" y1="-0.5" x2="33.5" y2="-3" />
                <polyline points="29,4 30.5,2.5 31.5,4.5" />
                <polyline points="35,4 33.5,2.5 32.5,4.5" />
              </g>
            </g>

            {/* Body: mismatched patches (like mismatched columns) with stitched seams. */}
            <g className="specimen__grid">
              <rect className="pc pc--1" x="18" y="26" width="16" height="14" />
              <rect className="pc pc--3" x="34" y="26" width="12" height="20" />
              <rect className="pc pc--2" x="18" y="40" width="16" height="28" />
              <rect className="pc pc--4" x="34" y="46" width="12" height="22" />
              <line className="specimen__seam" x1="34" y1="26" x2="34" y2="68" />
              <line className="specimen__seam" x1="18" y1="40" x2="34" y2="40" />
              <line className="specimen__seam" x1="34" y1="46" x2="46" y2="46" />
              <rect className="specimen__grid-frame" x="18" y="26" width="28" height="42" rx="2" />
            </g>

            {/* Satchel on a strap, with a book peeking out; the strap crosses his chest. */}
            <path className="specimen__strap" d="M41 27.5 Q31 47 19 63" fill="none" />
            <rect className="specimen__book" x="12" y="58.4" width="7" height="5.4" rx="0.8" />
            <line className="specimen__book-page" x1="13.2" y1="60" x2="17.8" y2="60" />
            <rect className="specimen__satchel" x="10" y="62" width="12" height="9" rx="2" />
            <path className="specimen__satchel-flap" d="M10.4 64.4 H21.6" fill="none" />

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

            {/* A new seam, drawn in when the stitch is applied, then held. */}
            {stitched ? (
              <g className="specimen__newseam">
                <path className="specimen__newseam-line" pathLength={1} d="M18 55 Q32 52.5 46 55" fill="none" />
                <g className="specimen__newseam-ticks">
                  <line x1="22" y1="52.4" x2="22" y2="56.4" />
                  <line x1="27" y1="52" x2="27" y2="56" />
                  <line x1="32" y1="51.8" x2="32" y2="55.8" />
                  <line x1="37" y1="52" x2="37" y2="56" />
                  <line x1="42" y1="52.4" x2="42" y2="56.4" />
                </g>
              </g>
            ) : null}

            {/* Goggles (proposals showing). */}
            {wearGoggles ? (
              <g className="specimen__goggles">
                <circle cx="29" cy="17" r="4" />
                <circle cx="37" cy="17" r="4" />
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

            {/* Stethoscope and clipboard while an Autopsy case file is open. */}
            {autopsyOpen ? (
              <>
                <g className="specimen__stethoscope">
                  <path d="M24 27 Q20 41 28 46 Q36 50 41 43" fill="none" />
                  <circle cx="41" cy="43" r="2.4" />
                </g>
                <g className="specimen__clipboard">
                  <rect x="47" y="50" width="12" height="15" rx="1" />
                  <line x1="50" y1="55" x2="56" y2="55" />
                  <line x1="50" y1="59" x2="56" y2="59" />
                </g>
              </>
            ) : null}

            {/* Bubbling flask while an Ask the Lab question is pending. */}
            {holdFlask ? (
              <g className="specimen__flask">
                <path d="M52 46 L52 52 L47 62 Q46 65 49 65 L58 65 Q61 65 60 62 L55 52 L55 46 Z" />
                <line x1="51" y1="46" x2="56" y2="46" />
                <path className="specimen__flask-liquid" d="M48.5 60 L58.5 60" />
                <circle className="specimen__flask-bubble specimen__flask-bubble--1" cx="51.5" cy="58" r="1.2" />
                <circle className="specimen__flask-bubble specimen__flask-bubble--2" cx="55" cy="59" r="1" />
                <circle className="specimen__flask-bubble specimen__flask-bubble--3" cx="53.5" cy="57" r="1.4" />
              </g>
            ) : null}

            {/* Recipe scroll held after a recipe is applied (decorative). */}
            {holdScroll ? (
              <g className="specimen__scroll">
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

          {/* The reaction's Effects (not rendered under reduced motion or Calm). */}
          {effectsOn ? <FrankFx id={reactionId} seq={reactionSeq} /> : null}

          {/*
            Bar-chart sign held up while an Ask result is shown. Drawn AFTER the
            body SVG (and given a z-index in CSS) because the body has an
            animated transform, which creates a stacking context that would
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
      {/* The "?" speech-bubble button by his head opens the guide. */}
      <button
        type="button"
        ref={buttonRef}
        className="frank-ask"
        aria-label="Ask Little Frank"
        aria-haspopup="dialog"
        aria-expanded={guideOpen}
        onClick={onToggleGuide}
      >
        <span aria-hidden="true">?</span>
      </button>
      {children}
    </div>
  );
}

export default Specimen;
