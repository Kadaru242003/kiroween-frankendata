/**
 * JoinControls — anchor / join-key controls and the many-to-many fan-out
 * warning for the stitched result (Feature 2, task 14; design "UI Layer /
 * JoinControls", Req 7.2, 7.4, 7.9, 7.11).
 *
 * The stitching chain is always a LEFT JOIN rooted at an *anchor* table. These
 * controls let the user:
 *
 *   - see the fixed join type (LEFT JOIN) and the current anchor (Req 7.2);
 *   - change the anchor to any loaded table (Req 7.2) — updates the plan's
 *     {@link StitchPlan.anchorTableName};
 *   - pick, per unordered table pair, which *approved* match is used as that
 *     pair's join key (Req 7.4) — updates the plan's
 *     {@link StitchPlan.joinKeysByPair};
 *   - apply the plan, which creates the stitched table and (via the parent)
 *     renders it with the existing `TablePreview` (Req 7.11); and
 *   - when the LEFT JOIN fanned out (a many-to-many correspondence produced
 *     MORE rows than the cleaned anchor input), see a warning with the
 *     before/after row counts and a Cancel action that undoes the apply (Req
 *     7.9).
 *
 * ## State ownership
 *
 * This component is a thin, controlled view: it holds no plan state of its own.
 * The parent (App) owns the working {@link StitchPlan} and the applied
 * {@link FanOutCounts} (read from the {@link StitchStore}); JoinControls reports
 * the user's intent through callbacks (`onChangeAnchor`, `onChangeJoinKey`,
 * `onApply`, `onCancel`). The anchor/key edits only reshape the plan object —
 * nothing is applied to DuckDB until `onApply`.
 *
 * ## Security — plain text only (Req 11.6 / design "rendered as plain text")
 *
 * Every table/column name and the one-line match reason are rendered as React
 * text nodes; React escapes them. This component never uses
 * `dangerouslySetInnerHTML`.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { FanOutCounts } from "../../core/stitching/stitch-applier";
import { pairKey } from "../../core/stitching/plan-assembly";
import type {
  MatchProposal,
  StitchPlan,
} from "../../core/stitching/types";
import "./JoinControls.css";

/** A loaded table descriptor JoinControls needs (name + row count for labels). */
export interface JoinControlsTable {
  tableName: string;
  rowCount: number;
}

/** One unordered table pair that has at least one approved match (a join). */
interface PairGroup {
  /** The stable `"tableA|tableB"` key for this pair. */
  key: string;
  /** The two logical table names (sorted, matching {@link pairKey}). */
  tableA: string;
  tableB: string;
  /** The approved matches connecting the pair, highest confidence first. */
  matches: MatchProposal[];
}

/** Props for {@link JoinControls}. */
export interface JoinControlsProps {
  /** The working plan (anchor + join keys + approved matches). */
  plan: StitchPlan;
  /** The loaded tables, for the anchor selector and row-count labels. */
  tables: readonly JoinControlsTable[];
  /**
   * The fan-out counts of the most recent apply, or `null` when nothing has
   * been applied yet. When {@link FanOutCounts.fannedOut} is `true` the warning
   * panel is shown with the before/after counts and a Cancel action (Req 7.9).
   */
  fanOut: FanOutCounts | null;
  /** `true` once the plan has been applied (a stitched table exists). */
  applied: boolean;
  /** Change the anchor table (Req 7.2). */
  onChangeAnchor: (nextAnchorTableName: string) => void;
  /** Choose a different approved match as a pair's join key (Req 7.4). */
  onChangeJoinKey: (pairKeyValue: string, nextMatchId: string) => void;
  /** Apply the plan — create the stitched table and preview it (Req 7.11). */
  onApply: () => void;
  /** Cancel/undo the applied stitch (the fan-out Cancel action, Req 7.9). */
  onCancel: () => void;
}

/** Render a 0..1 confidence as a compact percentage string (plain text). */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** A human-friendly "N row" / "N rows" label. */
function rowLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;
}

/**
 * A `before`/`after` cleaning payload shaped as a row-count snapshot
 * (`duplicate-rows` proposals carry `{ rowCount }`).
 */
function isRowCountValue(value: unknown): value is { rowCount: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "rowCount" in value &&
    typeof (value as { rowCount: unknown }).rowCount === "number"
  );
}

/**
 * The row count the LEFT JOIN will actually read for a table: when the plan
 * approves a `duplicate-rows` cleaning for that table, the join reads the
 * deduped cleaned copy, so the effective count is that proposal's `after`
 * row count — not the raw {@link JoinControlsTable.rowCount}. This keeps the
 * anchor label consistent with the fan-out "Before" count (Req 7.9), while the
 * anchor override still works because this is a pure per-table lookup.
 */
function effectiveRowCount(
  plan: StitchPlan,
  table: JoinControlsTable
): number {
  for (const cleaning of plan.approvedCleanings) {
    if (
      cleaning.kind === "duplicate-rows" &&
      cleaning.target.tableName === table.tableName &&
      isRowCountValue(cleaning.after)
    ) {
      return cleaning.after.rowCount;
    }
  }
  return table.rowCount;
}

/**
 * A short label for a match's column pairing, e.g.
 * `monsters."Monster Name" ↔ experiments.name`.
 */
function matchLabel(m: MatchProposal): string {
  return (
    `${m.left.tableName}.${m.left.columnName} ↔ ` +
    `${m.right.tableName}.${m.right.columnName}`
  );
}

/**
 * Group the plan's approved matches into unordered table pairs. Each pair that
 * has at least one approved match becomes a join whose key the user can choose
 * (Req 7.4); the matches within a pair are ordered by descending confidence
 * (ties by id) so the default/highest-confidence key leads the list.
 */
function groupMatchesByPair(matches: readonly MatchProposal[]): PairGroup[] {
  const byKey = new Map<string, PairGroup>();
  for (const m of matches) {
    const key = pairKey(m.left.tableName, m.right.tableName);
    const existing = byKey.get(key);
    if (existing) {
      existing.matches.push(m);
    } else {
      const [tableA, tableB] = [m.left.tableName, m.right.tableName].sort();
      byKey.set(key, { key, tableA: tableA!, tableB: tableB!, matches: [m] });
    }
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.matches.sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  // Deterministic group order so the controls render stably.
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return groups;
}

/**
 * The default key match id for a pair: the highest-confidence approved match
 * (ties by id), mirroring {@link defaultJoinKeysByPair} so the selected value
 * matches what apply would use when the plan has no explicit override.
 */
function defaultKeyMatchId(group: PairGroup): string {
  return group.matches[0]?.id ?? "";
}

/**
 * The anchor / join-key controls plus the fan-out warning. See the module doc.
 */
export function JoinControls({
  plan,
  tables,
  fanOut,
  applied,
  onChangeAnchor,
  onChangeJoinKey,
  onApply,
  onCancel,
}: JoinControlsProps): JSX.Element {
  const pairGroups = useMemo(
    () => groupMatchesByPair(plan.approvedMatches),
    [plan.approvedMatches]
  );

  const showFanOutWarning = fanOut?.fannedOut === true;

  // The Join panel mounts exactly once when the user clicks "Confirm & stitch"
  // (the working plan goes from empty to set), so this mount effect runs once
  // per confirm. It scrolls the panel into view, moves keyboard focus to the
  // "Apply & stitch" button (preventScroll so the browser does not jump a
  // second time), and triggers a brief one-shot green glow. All of it respects
  // prefers-reduced-motion: the scroll is instant and the glow is skipped.
  const sectionRef = useRef<HTMLElement | null>(null);
  const applyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [glow, setGlow] = useState(false);

  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const section = sectionRef.current;
    if (section && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({
        behavior: prefersReduced ? "auto" : "smooth",
        block: "start",
      });
    }
    applyButtonRef.current?.focus({ preventScroll: true });

    if (!prefersReduced) {
      setGlow(true);
      const timer = setTimeout(() => setGlow(false), 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
    // Mount-only: run once per confirm (the component remounts on each confirm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section
      ref={sectionRef}
      className={`join-controls${glow ? " join-controls--alive" : ""}`}
      aria-label="Join controls"
    >
      <header className="join-controls__header">
        <h3 className="join-controls__title">Join</h3>
        <p className="join-controls__subtitle">
          Tables are combined with a LEFT JOIN rooted at the anchor. Every
          anchor row is kept.
        </p>
      </header>

      <div className="join-controls__row">
        <span className="join-controls__join-type" aria-label="Join type">
          LEFT JOIN
        </span>
        <label className="join-controls__field">
          <span className="join-controls__field-label">Anchor table</span>
          <select
            className="join-controls__select"
            value={plan.anchorTableName}
            onChange={(e) => onChangeAnchor(e.target.value)}
            aria-label="Anchor table"
          >
            {tables.map((t) => (
              <option key={t.tableName} value={t.tableName}>
                {t.tableName} ({rowLabel(effectiveRowCount(plan, t))})
              </option>
            ))}
          </select>
        </label>
      </div>

      {pairGroups.length > 0 ? (
        <div className="join-controls__keys" aria-label="Join keys">
          <h4 className="join-controls__keys-title">Join keys</h4>
          <ul className="join-controls__keys-list">
            {pairGroups.map((group) => {
              const selectId = `join-key-${group.key}`;
              const selected =
                plan.joinKeysByPair[group.key] ?? defaultKeyMatchId(group);
              return (
                <li key={group.key} className="join-controls__key">
                  <label
                    className="join-controls__field-label"
                    htmlFor={selectId}
                  >
                    {group.tableA} ↔ {group.tableB} key
                  </label>
                  {group.matches.length > 1 ? (
                    <select
                      id={selectId}
                      className="join-controls__select"
                      value={selected}
                      onChange={(e) =>
                        onChangeJoinKey(group.key, e.target.value)
                      }
                    >
                      {group.matches.map((m) => (
                        <option key={m.id} value={m.id}>
                          {matchLabel(m)} ({formatConfidence(m.confidence)})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      id={selectId}
                      className="join-controls__key-single"
                    >
                      {matchLabel(group.matches[0]!)} (
                      {formatConfidence(group.matches[0]!.confidence)})
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="join-controls__actions">
        <button
          type="button"
          className="join-controls__apply"
          ref={applyButtonRef}
          onClick={onApply}
          disabled={applied}
        >
          {applied ? "Stitched" : "Apply & stitch"}
        </button>
        {applied ? (
          <button
            type="button"
            className="join-controls__undo"
            onClick={onCancel}
          >
            Undo stitch
          </button>
        ) : null}
      </div>

      {showFanOutWarning && fanOut ? (
        <div
          className="join-controls__warning"
          role="alert"
          aria-label="Many-to-many warning"
        >
          <p className="join-controls__warning-title">
            Many-to-many join: the result has more rows than the anchor.
          </p>
          <p className="join-controls__warning-counts">
            Before: {rowLabel(fanOut.anchorRowCount)} · After:{" "}
            {rowLabel(fanOut.resultRowCount)}
          </p>
          <p className="join-controls__warning-help">
            A matching column had duplicate values on both sides, so anchor rows
            were multiplied. Cancel to undo, or keep the stitched table if the
            fan-out is expected.
          </p>
          <button
            type="button"
            className="join-controls__warning-cancel"
            onClick={onCancel}
          >
            Cancel &amp; undo
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default JoinControls;
