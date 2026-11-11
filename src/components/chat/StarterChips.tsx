/**
 * StarterChips — renders the deterministic starter questions as clickable chips
 * (Feature 3, task 6; Req 2.1, 2.4).
 *
 * Presentational only: it receives the already-generated {@link StarterChip}s
 * (built by `generateStarterChips` against DuckDB in the App) and calls back
 * with the clicked chip so the panel can run its rule-built SQL directly — no
 * LLM. Chip questions are rendered as PLAIN TEXT (Req 9.5).
 */

import type { StarterChip } from "../../core/chat/starter-questions";
import "./StarterChips.css";

export interface StarterChipsProps {
  chips: StarterChip[];
  /** Invoked with the clicked chip; the panel runs its SQL. */
  onRun: (chip: StarterChip) => void;
  /** Disable the chips while a question is in flight. */
  disabled?: boolean;
}

export function StarterChips({ chips, onRun, disabled }: StarterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div className="ask-chips" aria-label="Starter questions">
      <p className="ask-chips__label">Try a starter question:</p>
      <ul className="ask-chips__list">
        {chips.map((chip, i) => (
          <li key={`${chip.tableName}:${i}`}>
            <button
              type="button"
              className="ask-chips__chip"
              onClick={() => onRun(chip)}
              disabled={disabled}
            >
              {chip.question}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default StarterChips;
