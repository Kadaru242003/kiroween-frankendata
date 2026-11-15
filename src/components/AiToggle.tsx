/**
 * Header switch for "AI: On / Off (fully local)" plus the "What leaves the
 * browser?" disclosure. When the build has AI disabled it shows a static
 * "Fully local" label instead. Session only.
 */
import { type JSX } from "react";
import { describeEgress } from "../core/egress-description";
import "./AiToggle.css";

export interface AiToggleProps {
  /** True when the build allows AI (VITE_AI_ENABLED is "true"). */
  buildEnabled: boolean;
  on: boolean;
  onChange: (on: boolean) => void;
}

export function AiToggle({ buildEnabled, on, onChange }: AiToggleProps): JSX.Element {
  if (!buildEnabled) {
    return (
      <div className="ai-toggle ai-toggle--static">
        <span className="ai-toggle__label">Fully local</span>
      </div>
    );
  }
  const egress = describeEgress();
  return (
    <div className="ai-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`ai-toggle__switch${on ? " ai-toggle__switch--on" : ""}`}
        onClick={() => onChange(!on)}
      >
        {on ? "AI: On" : "AI: Off (fully local)"}
      </button>
      <details className="ai-toggle__details">
        <summary>What leaves the browser?</summary>
        <p className="ai-toggle__intro">When AI is On, only this is sent:</p>
        <ul>
          {egress.sent.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="ai-toggle__never">{egress.neverSent}</p>
      </details>
    </div>
  );
}

export default AiToggle;
