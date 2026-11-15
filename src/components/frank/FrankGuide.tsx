/**
 * "Ask Little Frank": the offline guide panel, anchored to Frank like a speech
 * bubble. It answers from a local intent table (`src/core/frank/guide.ts`) and
 * makes no network call of any kind.
 *
 * Behavior: opens from his button, focus starts on the question input and stays
 * trapped inside (Tab and Shift+Tab cycle), Esc and a click outside close it and
 * focus returns to his button. It never scrolls the page. All text is plain text.
 */

import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from "react";
import { GUIDE_CHIPS, answerFor, type GuideAnswer } from "../../core/frank/guide";
import "./FrankGuide.css";

export interface FrankGuideProps {
  open: boolean;
  onClose: () => void;
  /** The context-aware tip for the app state. */
  tip: string;
  onPoke: () => void;
  calm: boolean;
  onCalmChange: (on: boolean) => void;
  /** His button, so a click on it is not an "outside" click. */
  toggleRef: RefObject<HTMLButtonElement | null>;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FrankGuide({
  open,
  onClose,
  tip,
  onPoke,
  calm,
  onCalmChange,
  toggleRef,
}: FrankGuideProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<GuideAnswer | null>(null);
  const titleId = useId();
  const inputId = useId();

  const ask = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setAnswer(answerFor(trimmed));
  }, []);

  // Focus the input when it opens.
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Esc closes from anywhere; a pointer press outside closes too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
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
      aria-labelledby={titleId}
      aria-label="Ask Little Frank"
      onKeyDown={onPanelKeyDown}
    >
      <div className="frank-guide__header">
        <h2 id={titleId} className="frank-guide__title">
          Ask Little Frank
        </h2>
        <button type="button" className="frank-guide__close" aria-label="Close Ask Little Frank" onClick={onClose}>
          x
        </button>
      </div>

      <p className="frank-guide__tip" data-testid="frank-tip">
        {tip}
      </p>

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

      <div className="frank-guide__answer" role="status" aria-live="polite" data-testid="frank-answer">
        {answer?.paragraphs.map((p, i) => (
          <p key={`${answer.intentId ?? "fallback"}-${i}`}>{p}</p>
        ))}
      </div>

      <div className="frank-guide__footer">
        <button type="button" className="frank-guide__poke" onClick={onPoke}>
          Poke Frank
        </button>
        <label className="frank-guide__calm">
          <input type="checkbox" checked={calm} onChange={(e) => onCalmChange(e.target.checked)} />
          <span>Calm Frank</span>
        </label>
      </div>
    </div>
  );
}

export default FrankGuide;
