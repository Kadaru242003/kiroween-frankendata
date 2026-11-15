/**
 * Compact cards for the earlier turns of the Ask thread (Smarter Ask). Shown
 * above the current answer, oldest first. All text is plain text.
 */
import type { AskTurn } from "../../core/chat/thread";
import { BarChart } from "./charts/BarChart";
import { LineChart } from "./charts/LineChart";

export function ThreadCards({ turns }: { turns: readonly AskTurn[] }) {
  if (turns.length === 0) return null;
  return (
    <div className="ask-thread" aria-label="Earlier questions">
      {turns.map((turn, i) => {
        const { outcome } = turn;
        return (
          <article
            key={`${i}:${turn.question}`}
            className="ask-thread__card"
            aria-label={`Earlier question ${i + 1}`}
          >
            <p className="ask-thread__question">{turn.question}</p>
            <p className="ask-thread__meta">
              {outcome.rowCount} {outcome.rowCount === 1 ? "row" : "rows"}
            </p>
            <details className="ask-thread__sql">
              <summary>SQL</summary>
              <pre>{outcome.sql}</pre>
            </details>
            {outcome.chart?.type === "bar" ? (
              <BarChart spec={outcome.chart} columns={outcome.columns} rows={outcome.rows} />
            ) : null}
            {outcome.chart?.type === "line" ? (
              <LineChart spec={outcome.chart} columns={outcome.columns} rows={outcome.rows} />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export default ThreadCards;
