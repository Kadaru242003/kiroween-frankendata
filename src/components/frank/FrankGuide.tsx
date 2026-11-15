/**
 * "Ask Little Frank": the offline guide, drawn as a comic speech bubble coming
 * from Frank's head (the tail points at him). It answers from a local intent
 * table (`src/core/frank/guide.ts`) and makes no network call of any kind.
 *
 * Top to bottom: the context tip, Frank's latest answer (large, in his voice,
 * typed out quickly; instant under reduced motion or Calm Frank), the input,
 * the suggestion chips, and the Calm Frank toggle. The answer is always above
 * the chips.
 *
 * Behavior: opens from the "?" button, focus starts on the question input and
 * stays trapped inside (Tab and Shift+Tab cycle), Esc and a click outside close
 * it and focus returns to the "?" button. A press on Frank or on the "?" is not
 * an outside click. It never scrolls the page. All text is plain text.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { GREETING, GUIDE_CHIPS, answerFor } from "../../core/frank/guide";
import "./FrankGuide.css";

export interface FrankGuideProps {
  open: boolean;
  onClose: () => void;
  /** The context-aware tip for the app state. */
  tip: string;
  calm: boolean;
  onCalmChange: (on: boolean) => void;
  /** Show answers at once (reduced motion or Calm Frank). */
  instant: boolean;
  /** The "?" button, so a click on it is not an "outside" click. */
  toggleRef: RefObject<HTMLButtonElement | null>;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The typewriter reveal finishes in about this long, whatever the length. */
const TYPE_TOTAL_MS = 1200;
const TYPE_TICK_MS = 24;

/** One answer in Frank's voice. Screen readers get the whole text at once. */
function TypedAnswer({ paragraphs, instant }: { paragraphs: string[]; instant: boolean }): JSX.Element {
  const total = paragraphs.reduce((n, p) => n + p.length, 0);
  const [shown, setShown] = useState(instant ? total : 0);

  useEffect(() => {
    if (instant || total === 0) return;
    const step = Math.max(1, Math.ceil(total / (TYPE_TOTAL_MS / TYPE_TICK_MS)));
    const timer = setInterval(() => {
      setShown((n) => {
        const next = Math.min(total, n + step);
        if (next >= total) clearInterval(timer);
        return next;
      });
    }, TYPE_TICK_MS);
    return () => clearInterval(timer);
  }, [instant, total]);

  const visible = instant ? total : shown;
  let left = visible;
  return (
    <>
      {/* The full text for assistive technology, announced once. */}
      <div className="frank-guide__sr">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {/* The typed text. The untyped rest keeps its place so nothing jumps. */}
      <div className="frank-guide__typed" aria-hidden="true">
        {paragraphs.map((p, i) => {
          const typed = p.slice(0, Math.max(0, left));
          left -= p.length;
          return (
            <p key={i}>
              <span>{typed}</span>
              <span className="frank-guide__rest">{p.slice(typed.length)}</span>
            </p>
          );
        })}
      </div>
    </>
  );
}

interface Shown {
  n: number;
  intentId: string | null;
  paragraphs: string[];
}

export function FrankGuide({
  open,
  onClose,
  tip,
  calm,
  onCalmChange,
  instant,
  toggleRef,
}: FrankGuideProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Shown>({ n: 0, intentId: null, paragraphs: [GREETING] });
  const inputId = useId();

  const ask = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    const found = answerFor(trimmed, new Date());
    setAnswer((prev) => ({ n: prev.n + 1, intentId: found.intentId, paragraphs: found.paragraphs }));
  }, []);

  // Focus the input when it opens.
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Esc closes from anywhere; a pointer press outside closes too (but not a
  // press on Frank or on the "?" button).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target === null || typeof target.closest !== "function") return;
      if (panelRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      if (target.closest(".specimen-button, .frank-ask") !== null) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, onClose, toggleRef]);

  // Trap focus inside the panel.
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (panel === null) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="frank-guide"
      role="dialog"
      aria-modal="true"
      aria-label="Ask Little Frank"
      onKeyDown={onPanelKeyDown}
    >
      <div className="frank-guide__scroll">
      <button type="button" className="frank-guide__close" aria-label="Close Ask Little Frank" onClick={onClose}>
        x
      </button>

      <p className="frank-guide__tip" data-testid="frank-tip">
        {tip}
      </p>

      <div className="frank-guide__answer" role="status" aria-live="polite" data-testid="frank-answer">
        <TypedAnswer key={answer.n} paragraphs={answer.paragraphs} instant={instant} />
      </div>

      <form
        className="frank-guide__form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <label htmlFor={inputId} className="frank-guide__label">
          Your question
        </label>
        <div className="frank-guide__row">
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            className="frank-guide__input"
            value={question}
            maxLength={200}
            autoComplete="off"
            placeholder="Ask me about this lab"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button type="submit" className="frank-guide__ask">
            Ask
          </button>
        </div>
      </form>

      <ul className="frank-guide__chips" aria-label="Suggested questions">
        {GUIDE_CHIPS.map((chip) => (
          <li key={chip}>
            <button
              type="button"
              className="frank-guide__chip"
              onClick={() => {
                setQuestion(chip);
                ask(chip);
              }}
            >
              {chip}
            </button>
          </li>
        ))}
      </ul>

      <div className="frank-guide__footer">
        <label className="frank-guide__calm">
          <input type="checkbox" checked={calm} onChange={(e) => onCalmChange(e.target.checked)} />
          <span>Calm Frank</span>
        </label>
      </div>
      </div>
    </div>
  );
}

export default FrankGuide;
