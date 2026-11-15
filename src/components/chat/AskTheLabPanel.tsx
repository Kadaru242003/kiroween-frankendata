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

import { useCallback, useEffect, useRef, useState } from "react";
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
import { LineChart } from "./charts/LineChart";
import { ThreadCards } from "./ThreadCards";
import { toThread } from "../../core/chat/thread";
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
  /**
   * Names of the tables that exist now. A recent question that mentions a table
   * that no longer exists (for example a replaced stitch_1_result) is hidden.
   */
  knownTables?: readonly string[];
  /**
   * "Ask about this" request from a table card: when `nonce` changes the input
   * is prefilled with `text`, brought into view, and focused.
   */
  prefill?: { text: string; nonce: number } | null;
  /** Called once after a prefill was applied, so the owner can drop the request. */
  onPrefillHandled?: () => void;
}

export const ASK_SUBMIT_LABEL = "Ask";
export const ASK_PLACEHOLDER = "Ask a question about your tables…";
/** The single notice shown when AI is off or unavailable (once, under the input). */
export const AI_UNAVAILABLE_MESSAGE =
  "AI is off here. Starter questions still work without it.";
export const PRIVACY_NOTE =
  "Your data stays in the browser. When AI is on, it sees only column names and a few sample values, never your full rows.";

export function AskTheLabPanel({
  controller,
  store,
  chips,
  aiAvailable,
  knownTables,
  prefill = null,
  onPrefillHandled,
}: AskTheLabPanelProps) {
  const { history, outcome, loading, turns, epoch } = useAskStore(store);
  const [question, setQuestion] = useState("");
  // Recent questions that mention a table that no longer exists are hidden.
  // Names seen during the session are remembered so any dropped table matches.
  const seenTables = useRef(new Set<string>());
  if (knownTables) for (const t of knownTables) seenTables.current.add(t);
  const visibleHistory = knownTables
    ? history.filter((h) => {
        const gone = [...seenTables.current].filter((t) => !knownTables.includes(t));
        const mentions = (name: string) =>
          new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_])`).test(h);
        if (gone.some(mentions)) return false;
        const stitch = h.match(/stitch_\d+_(?:result|clean_\w+)/g) ?? [];
        return stitch.every((t) => knownTables.includes(t));
      })
    : history;
  const [topicNote, setTopicNote] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  // Set only by the Ask form, so the newest answer takes focus only when the
  // user submitted the question (never for chips or history buttons).
  const focusNextOutcome = useRef(false);
  // Any question the user asks scrolls its new answer into view (smoothly,
  // instantly under prefers-reduced-motion).
  const scrollNextOutcome = useRef(false);
  // After the first question in a topic the starters collapse into a toggle.
  const [startersExpanded, setStartersExpanded] = useState(false);

  useEffect(() => {
    if (!loading && outcome && focusNextOutcome.current) {
      focusNextOutcome.current = false;
      outcomeRef.current?.focus({ preventScroll: true });
    }
    if (!loading && outcome && scrollNextOutcome.current) {
      scrollNextOutcome.current = false;
      const reduce =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      outcomeRef.current?.scrollIntoView?.({
        behavior: reduce ? "auto" : "smooth",
        block: "nearest",
      });
    }
  }, [loading, outcome]);

  // A fresh turn replaces the "new topic" note so it can be announced again.
  useEffect(() => {
    if (turns.length > 0) setTopicNote("");
  }, [turns.length]);

  // Reset lab clears the whole Ask state: also empty the input text.
  useEffect(() => {
    setQuestion("");
    setTopicNote("");
    setStartersExpanded(false);
  }, [epoch]);

  const prefillNonce = prefill?.nonce;
  useEffect(() => {
    if (prefill === null || prefillNonce === undefined) return;
    setQuestion(prefill.text);
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panelRef.current?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
    inputRef.current?.focus({ preventScroll: true });
    // One-shot: the request is consumed so a remount or reset never re-applies it.
    onPrefillHandled?.();
    // Only a new request (nonce) should prefill.
  }, [prefillNonce]); // eslint-disable-line react-hooks/exhaustive-deps
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
      scrollNextOutcome.current = true;
      const thread = toThread(store.getState().turns);
      store.pushQuestion(trimmed);
      store.setLoading(true);
      const result =
        thread.length > 0
          ? await controller.ask(trimmed, thread)
          : await controller.ask(trimmed);
      store.setOutcome(result);
      if (result.kind === "ok") store.pushTurn(trimmed, result);
    },
    [controller, store, loading]
  );

  const runChip = useCallback(
    async (chip: StarterChip) => {
      if (loading) return;
      scrollNextOutcome.current = true;
      store.pushQuestion(chip.question);
      store.setLoading(true);
      const result = await controller.runSql(chip.sql, chip.question, chip.chart);
      store.setOutcome(result);
      if (result.kind === "ok") store.pushTurn(chip.question, result);
    },
    [controller, store, loading]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      focusNextOutcome.current = true;
      void runFreeForm(question);
    },
    [runFreeForm, question]
  );

  return (
    <section className="ask-panel" aria-label="Ask the Lab" ref={panelRef}>
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
          ref={inputRef}
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
        {turns.length > 0 ? (
          <button
            type="button"
            className="ask-panel__new-topic"
            onClick={() => {
              store.clearThread();
              setStartersExpanded(false);
              setQuestion("");
              setTopicNote("Started a new topic");
              inputRef.current?.focus({ preventScroll: true });
            }}
          >
            New topic
          </button>
        ) : null}
      </form>

      <p className="ask-panel__sr" role="status" aria-live="polite">
        {topicNote}
      </p>
      {!aiAvailable || outcome?.kind === "ai-unavailable" ? (
        <p className="ask-panel__ai-note" role="status">
          {AI_UNAVAILABLE_MESSAGE}
        </p>
      ) : null}
      {visibleHistory.length > 0 ? (
        <div className="ask-panel__history" aria-label="Recent questions">
          <p className="ask-panel__history-label">Recent:</p>
          <ul className="ask-panel__history-list">
            {visibleHistory.map((h, i) => (
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

      {turns.length > 0 ? (
        <button
          type="button"
          className="ask-panel__chips-toggle"
          aria-expanded={startersExpanded}
          onClick={() => setStartersExpanded((v) => !v)}
        >
          Starter questions
        </button>
      ) : null}
      {turns.length === 0 || startersExpanded ? (
        <StarterChips chips={visibleChips} onRun={(c) => void runChip(c)} disabled={loading} />
      ) : null}
      {hasOverflowChips && (turns.length === 0 || startersExpanded) ? (
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


      {loading ? (
        <div
          className="ask-panel__brewing"
          role="status"
          aria-live="polite"
        >
          <svg className="ask-panel__brew-flask" viewBox="0 0 48 56" aria-hidden="true">
            <path
              className="ask-panel__brew-glass"
              d="M19 4 h10 v16 l11 26 a3 3 0 0 1 -3 4 h-26 a3 3 0 0 1 -3 -4 l11 -26 z"
              fill="none"
            />
            <path
              className="ask-panel__brew-liquid"
              d="M13.5 40 h21 l4 6 a3 3 0 0 1 -3 4 h-23 a3 3 0 0 1 -3 -4 z"
            />
            <circle className="ask-panel__brew-bubble ask-panel__brew-bubble--1" cx="21" cy="46" r="1.6" />
            <circle className="ask-panel__brew-bubble ask-panel__brew-bubble--2" cx="26" cy="47" r="1.2" />
            <circle className="ask-panel__brew-bubble ask-panel__brew-bubble--3" cx="24" cy="48" r="2" />
          </svg>
          <p className="ask-panel__brew-text">Brewing your query...</p>
        </div>
      ) : null}

      <ThreadCards turns={turns.filter((t) => t.outcome !== outcome)} />
      {!loading && outcome ? (
        <div className="ask-panel__outcome" ref={outcomeRef} tabIndex={-1} aria-label="Latest answer">
          {outcome.kind === "ok" ? (
            <>
              {history[0] ? (
                <p className="ask-panel__question">{history[0]}</p>
              ) : null}
              {outcome.chart && outcome.chart.type === "bar" ? (
                <BarChart
                  spec={outcome.chart}
                  columns={outcome.columns}
                  rows={outcome.rows}
                />
              ) : null}
              {outcome.chart && outcome.chart.type === "line" ? (
                <LineChart
                  spec={outcome.chart}
                  columns={outcome.columns}
                  rows={outcome.rows}
                />
              ) : null}
              <ResultTableView
                columns={outcome.columns}
                rows={outcome.rows}
                capped={outcome.capped}
              />
              <SqlBlock
                sql={outcome.sql}
                explanation={outcome.explanation === history[0] ? "" : outcome.explanation}
              />
            </>
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
