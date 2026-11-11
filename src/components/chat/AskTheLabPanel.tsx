/**
 * AskTheLabPanel — the "Ask the Lab" chat-SQL panel (Feature 3, task 6).
 *
 * Composes the question flow at the UI edge: a text input + submit (≤
 * {@link ASK_MAX_QUESTION_CHARS} chars), a loading state, the recent-questions
 * history, the deterministic {@link StarterChips}, a privacy note, and the
 * rendered {@link AskOutcome} (SQL block + result table, an "AI unavailable →
 * use the chips" message, or a friendly error).
 *
 * The panel is purely a view over the injected {@link AskController} and
 * {@link AskStore}: it never touches DuckDB or the network directly. When no
 * SqlProvider is wired (AI disabled, or before task 9's ProxySqlProvider), the
 * controller returns `ai-unavailable` for free-form questions and the panel
 * shows the chips message — making NO network request (Req 6.4, 9.4). Starter
 * chips always run directly through the controller against real DuckDB (Req
 * 2.4, 2.5).
 *
 * Every rendered value, label, explanation, and SQL string is PLAIN TEXT
 * (Req 9.5). The panel is only mounted by the App when at least one queryable
 * table exists (Req 1.1).
 */

import { useCallback, useState } from "react";
import {
  ASK_MAX_QUESTION_CHARS,
  ASK_VISIBLE_CHIPS_LIMIT,
} from "../../core/chat/types";
import type { AskController } from "../../core/chat/ask-controller";
import type { StarterChip } from "../../core/chat/starter-questions";
import { AskStore, useAskStore } from "../../state/ask-store";
import { SqlBlock } from "./SqlBlock";
import { ResultTableView } from "./ResultTableView";
import { StarterChips } from "./StarterChips";
import { BarChart } from "./charts/BarChart";
import "./AskTheLabPanel.css";

export interface AskTheLabPanelProps {
  /** The wired controller (runs chip/free-form questions). */
  controller: AskController;
  /** The session store holding history + the latest outcome + loading flag. */
  store: AskStore;
  /** The deterministic starter chips for the current tables. */
  chips: StarterChip[];
  /**
   * Whether the LLM path is available (VITE_AI_ENABLED === "true" AND a
   * provider is wired). When false, the input still works but free-form
   * questions resolve to the "AI unavailable" message with no network call.
   */
  aiAvailable: boolean;
}

export const ASK_SUBMIT_LABEL = "Ask";
export const ASK_PLACEHOLDER = "Ask a question about your tables…";
export const AI_UNAVAILABLE_MESSAGE =
  "The lab's AI is unavailable right now. Try one of the starter questions below: they run without AI.";
export const PRIVACY_NOTE =
  "Your data stays in the browser. When AI is on, it sees only column names and a few sample values, never your full rows.";

export function AskTheLabPanel({
  controller,
  store,
  chips,
  aiAvailable,
}: AskTheLabPanelProps) {
  const { history, outcome, loading } = useAskStore(store);
  const [question, setQuestion] = useState("");
  // Starter-chip overflow: show at most ASK_VISIBLE_CHIPS_LIMIT until expanded.
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const hasOverflowChips = chips.length > ASK_VISIBLE_CHIPS_LIMIT;
  const visibleChips =
    chipsExpanded || !hasOverflowChips
      ? chips
      : chips.slice(0, ASK_VISIBLE_CHIPS_LIMIT);

  const runFreeForm = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || loading) return;
      store.pushQuestion(trimmed);
      store.setLoading(true);
      const result = await controller.ask(trimmed);
      store.setOutcome(result);
    },
    [controller, store, loading]
  );

  const runChip = useCallback(
    async (chip: StarterChip) => {
      if (loading) return;
      store.pushQuestion(chip.question);
      store.setLoading(true);
      const result = await controller.runSql(chip.sql, chip.question, chip.chart);
      store.setOutcome(result);
    },
    [controller, store, loading]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void runFreeForm(question);
    },
    [runFreeForm, question]
  );

  return (
    <section className="ask-panel" aria-label="Ask the Lab">
      <header className="ask-panel__header">
        <h2 className="ask-panel__title">Ask the Lab</h2>
        <p className="ask-panel__subtitle">
          Ask a plain-English question about your loaded tables.
        </p>
      </header>

      <p className="ask-panel__privacy">{PRIVACY_NOTE}</p>

      <form className="ask-panel__form" onSubmit={handleSubmit}>
        <input
          className="ask-panel__input"
          type="text"
          value={question}
          maxLength={ASK_MAX_QUESTION_CHARS}
          placeholder={ASK_PLACEHOLDER}
          aria-label="Question"
          onChange={(e) => setQuestion(e.target.value)}
          disabled={loading}
        />
        <button
          type="submit"
          className="ask-panel__submit"
          disabled={loading || question.trim().length === 0}
        >
          {loading ? "Thinking…" : ASK_SUBMIT_LABEL}
        </button>
      </form>

      {history.length > 0 ? (
        <div className="ask-panel__history" aria-label="Recent questions">
          <p className="ask-panel__history-label">Recent:</p>
          <ul className="ask-panel__history-list">
            {history.map((h, i) => (
              <li key={`${i}:${h}`}>
                <button
                  type="button"
                  className="ask-panel__history-item"
                  onClick={() => void runFreeForm(h)}
                  disabled={loading}
                >
                  {h}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <StarterChips chips={visibleChips} onRun={(c) => void runChip(c)} disabled={loading} />
      {hasOverflowChips ? (
        <button
          type="button"
          className="ask-panel__chips-toggle"
          onClick={() => setChipsExpanded((v) => !v)}
          aria-expanded={chipsExpanded}
        >
          {chipsExpanded
            ? "Show fewer"
            : `Show more (${chips.length - ASK_VISIBLE_CHIPS_LIMIT})`}
        </button>
      ) : null}

      {!aiAvailable ? (
        <p className="ask-panel__ai-note">
          AI is off, starter questions still work.
        </p>
      ) : null}

      {loading ? (
        <p className="ask-panel__loading" role="status">
          Consulting the lab…
        </p>
      ) : null}

      {!loading && outcome ? (
        <div className="ask-panel__outcome">
          {outcome.kind === "ok" ? (
            <>
              <SqlBlock sql={outcome.sql} explanation={outcome.explanation} />
              <ResultTableView
                columns={outcome.columns}
                rows={outcome.rows}
                capped={outcome.capped}
              />
              {outcome.chart && outcome.chart.type === "bar" ? (
                <BarChart
                  spec={outcome.chart}
                  columns={outcome.columns}
                  rows={outcome.rows}
                />
              ) : null}
            </>
          ) : null}
          {outcome.kind === "ai-unavailable" ? (
            <p className="ask-panel__message" role="status">
              {AI_UNAVAILABLE_MESSAGE}
            </p>
          ) : null}
          {outcome.kind === "error" ? (
            <p className="ask-panel__message ask-panel__message--error" role="alert">
              {outcome.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default AskTheLabPanel;
