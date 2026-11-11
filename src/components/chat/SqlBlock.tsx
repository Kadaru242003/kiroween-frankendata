/**
 * SqlBlock — shows the generated SQL in a code block with a copy button and a
 * one-sentence explanation (Feature 3, task 6; Req 1.5).
 *
 * Presentational only. Both the SQL and the explanation are rendered as PLAIN
 * TEXT (via React's default text-node escaping) — never as markup (Req 9.5).
 * The copy button uses the async Clipboard API when available and falls back to
 * a no-op failure state otherwise; copy failure never throws.
 */

import { useCallback, useState } from "react";
import "./SqlBlock.css";

export interface SqlBlockProps {
  /** The generated SQL to display and copy. */
  sql: string;
  /** The model's one-sentence explanation (plain text). */
  explanation: string;
}

export const COPY_LABEL = "Copy SQL";
export const COPIED_LABEL = "Copied";

export function SqlBlock({ sql, explanation }: SqlBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(sql);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // Copy failures are non-fatal; leave the label unchanged.
      }
    })();
  }, [sql]);

  return (
    <section className="ask-sql" aria-label="Generated SQL">
      {explanation ? <p className="ask-sql__explanation">{explanation}</p> : null}
      <div className="ask-sql__code-wrap">
        <pre className="ask-sql__code">
          <code>{sql}</code>
        </pre>
        <button
          type="button"
          className="ask-sql__copy"
          onClick={handleCopy}
          aria-label={COPY_LABEL}
        >
          {copied ? COPIED_LABEL : COPY_LABEL}
        </button>
      </div>
    </section>
  );
}

export default SqlBlock;
