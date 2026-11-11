/**
 * StitchEntryPoint — the visible "Stitch" entry point into the approval screen
 * (Feature 2, task 13; design "Fewer than two tables").
 *
 * Stitching is only meaningful across two or more loaded tables, so the entry
 * point renders ONLY when `tableCount >= MIN_TABLES_FOR_STITCHING`. Below that
 * threshold it renders nothing, so the approval screen is unreachable. This is
 * a thin presentational control: it reports the user's intent via `onOpen` and
 * owns no stitching state. The App composes it with the `ApprovalScreen` and the
 * open/closed toggle.
 *
 * Extracted into its own component (rather than inlined in App) so the
 * ">= 2 tables" gating can be unit-tested without initializing the DuckDB-WASM
 * stack that the App entry component sets up.
 */

import { type JSX } from "react";

/**
 * The minimum number of loaded tables before the entry point appears. Stitching
 * joins across tables, so it needs at least two.
 */
export const MIN_TABLES_FOR_STITCHING = 2;

/** `true` when the stitch entry point should be shown for `tableCount`. */
export function shouldShowStitchEntry(tableCount: number): boolean {
  return tableCount >= MIN_TABLES_FOR_STITCHING;
}

/** Props for {@link StitchEntryPoint}. */
export interface StitchEntryPointProps {
  /** Number of currently loaded tables; gates visibility. */
  tableCount: number;
  /** Invoked when the user activates the entry point to open the approval screen. */
  onOpen: () => void;
}

/**
 * Renders a "Stitch tables" button only when two or more tables are loaded;
 * otherwise renders nothing.
 */
export function StitchEntryPoint({
  tableCount,
  onOpen,
}: StitchEntryPointProps): JSX.Element | null {
  if (!shouldShowStitchEntry(tableCount)) {
    return null;
  }
  return (
    <section className="lab-stitch-entry" aria-label="Stitching">
      <button
        type="button"
        className="lab-stitch-entry__button"
        onClick={onOpen}
      >
        Stitch tables
      </button>
    </section>
  );
}

export default StitchEntryPoint;
