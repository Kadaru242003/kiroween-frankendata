/**
 * StitchEntryPoint — the visible "Stitch" entry point into the approval screen,
 * plus per-table selection checkboxes (Feature 2, task 13 + polish batch 2).
 *
 * Stitching is only meaningful across two or more loaded tables, so the entry
 * point renders ONLY when `tables.length >= MIN_TABLES_FOR_STITCHING`. Below
 * that threshold it renders nothing, so the approval screen is unreachable.
 *
 * ## Table selection (polish batch 2, item 1)
 *
 * With more than two tables loaded, comparing every table against every other
 * produces a lot of noise (including a table matched against another copy of
 * itself). A checkbox next to each table name lets the user pick which tables
 * participate; the controller then proposes matches/cleanups over only the
 * CHECKED tables. All tables are checked by default (the App adds newly-loaded
 * tables to the checked set as they arrive). The "Stitch tables" button needs
 * at least two checked tables and is disabled otherwise, with a short hint.
 *
 * This is a thin presentational control: it reports the user's intent via
 * `onToggleTable` / `onOpen` and owns no stitching state. The App composes it
 * with the `ApprovalScreen` and the open/closed toggle, and owns the selected
 * set.
 *
 * Extracted into its own component (rather than inlined in App) so the gating
 * and selection logic can be unit-tested without initializing the DuckDB-WASM
 * stack that the App entry component sets up.
 */

import { type JSX } from "react";

/**
 * The minimum number of loaded tables before the entry point appears, and the
 * minimum number of CHECKED tables before stitching can start. Stitching joins
 * across tables, so it needs at least two.
 */
export const MIN_TABLES_FOR_STITCHING = 2;

/** `true` when the stitch entry point should be shown for `tableCount`. */
export function shouldShowStitchEntry(tableCount: number): boolean {
  return tableCount >= MIN_TABLES_FOR_STITCHING;
}

/** `true` when enough tables are checked to start stitching. */
export function canStartStitching(selectedCount: number): boolean {
  return selectedCount >= MIN_TABLES_FOR_STITCHING;
}

/** The minimal loaded-table shape the entry point needs (name only). */
export interface StitchEntryTable {
  tableName: string;
}

/** Props for {@link StitchEntryPoint}. */
export interface StitchEntryPointProps {
  /** The currently loaded tables; gates visibility and lists the checkboxes. */
  tables: readonly StitchEntryTable[];
  /** The set of table names currently checked (participating in stitching). */
  selectedTableNames: ReadonlySet<string>;
  /** Toggle a single table's participation. */
  onToggleTable: (tableName: string, checked: boolean) => void;
  /** Invoked when the user activates the entry point to open the approval screen. */
  onOpen: () => void;
}

/**
 * Renders the per-table selection checkboxes and a "Stitch tables" button, only
 * when two or more tables are loaded; otherwise renders nothing. The button is
 * disabled until at least two tables are checked (with a short hint).
 */
export function StitchEntryPoint({
  tables,
  selectedTableNames,
  onToggleTable,
  onOpen,
}: StitchEntryPointProps): JSX.Element | null {
  if (!shouldShowStitchEntry(tables.length)) {
    return null;
  }
  const selectedCount = tables.reduce(
    (n, t) => (selectedTableNames.has(t.tableName) ? n + 1 : n),
    0
  );
  const canStart = canStartStitching(selectedCount);

  return (
    <section className="lab-stitch-entry" aria-label="Stitching">
      <fieldset className="lab-stitch-entry__tables">
        <legend className="lab-stitch-entry__legend">
          Tables to stitch
        </legend>
        <ul className="lab-stitch-entry__list">
          {tables.map((t) => {
            const checked = selectedTableNames.has(t.tableName);
            return (
              <li key={t.tableName} className="lab-stitch-entry__item">
                <label className="lab-stitch-entry__label">
                  <input
                    type="checkbox"
                    className="lab-stitch-entry__checkbox"
                    checked={checked}
                    onChange={(e) => onToggleTable(t.tableName, e.target.checked)}
                  />
                  <span className="lab-stitch-entry__table-name">
                    {t.tableName}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <button
        type="button"
        className="lab-stitch-entry__button"
        onClick={onOpen}
        disabled={!canStart}
      >
        Stitch tables
      </button>
      {!canStart ? (
        <p className="lab-stitch-entry__hint">
          Check at least two tables to stitch.
        </p>
      ) : null}
    </section>
  );
}

export default StitchEntryPoint;
