/**
 * Header switch for "AI: On / Off (fully local)" plus the "What leaves the
 * browser?" popover. The switch and the trigger share one centered row; the
 * popover floats under the trigger so it never pushes the title or page down.
 * It closes on outside click and Esc. When the build has AI disabled it shows
 * a static "Fully local" label instead. Session only.
 */
import { useEffect, useId, useRef, useState, type JSX } from "react";
import { describeEgress } from "../core/egress-description";
import "./AiToggle.css";

export interface AiToggleProps {
  /** True when the build allows AI (VITE_AI_ENABLED is "true"). */
  buildEnabled: boolean;
  on: boolean;
  onChange: (on: boolean) => void;
}

export function AiToggle({ buildEnabled, on, onChange }: AiToggleProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!buildEnabled) {
    return (
      <div className="ai-toggle ai-toggle--static">
        <span className="ai-toggle__label">Fully local</span>
      </div>
    );
  }
  const egress = describeEgress();
  return (
    <div className="ai-toggle" ref={rootRef}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`ai-toggle__switch${on ? " ai-toggle__switch--on" : ""}`}
        onClick={() => onChange(!on)}
      >
        {on ? "AI: On" : "AI: Off (fully local)"}
      </button>
      <div className="ai-toggle__anchor">
        <button
          type="button"
          ref={triggerRef}
          className="ai-toggle__trigger"
          aria-expanded={open}
          aria-controls={popId}
          onClick={() => setOpen((v) => !v)}
        >
          What leaves the browser?
        </button>
        {open ? (
          <div id={popId} className="ai-toggle__popover" role="region" aria-label="What leaves the browser?">
            <p className="ai-toggle__intro">When AI is On, only this is sent:</p>
            <ul>
              {egress.sent.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="ai-toggle__never">{egress.neverSent}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default AiToggle;
