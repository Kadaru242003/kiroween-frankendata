/**
 * DemoDataControl (task 18.2) — the "Load demo data" control that sits
 * alongside the DropZone (Req 13.1).
 *
 * Like {@link DropZone}, this is a presentational React component deliberately
 * decoupled from the core pipeline: it never imports or instantiates the
 * {@link DemoDataLoader}, the {@link IntakeController}, DuckDB, or the parsers.
 * Instead it reports a single user intent — "load the demo data" — through an
 * `onLoadDemo()` callback. The App wires that callback (task 19.1) to call
 * `demoDataLoader.load()` and feed the resulting files through the same
 * `IntakeController.intake` pipeline used for dropped files (Req 13.2). Keeping
 * the component this thin lets it be unit-tested without the DuckDB stack.
 *
 * ## Behavior
 *
 * - Renders a real, accessibly-named `<button>` labeled "Load demo data"
 *   (Req 13.1). Accessibility: a genuine `<button>` element whose disabled
 *   state is communicated via the native `disabled` attribute.
 * - On activation, invokes {@link DemoDataControlProps.onLoadDemo} (Req 13.2).
 * - If the callback returns a promise, the button disables itself and shows a
 *   brief "Loading…" label until the promise settles, then re-enables. This
 *   both gives feedback and guards against double-clicks kicking off the demo
 *   load more than once.
 *
 * Placement ("alongside the DropZone") is composed by the App (task 19.1); here
 * the root carries a stable `frankendata-demo-control` class as a layout hook.
 */

import { useCallback, useRef, useState, type JSX } from "react";
import "./DemoDataControl.css";

/** The accessible label / visible text of the control in its idle state (Req 13.1). */
export const LOAD_DEMO_DATA_LABEL = "Load demo data";

/** The label shown while a returned {@link DemoDataControlProps.onLoadDemo} promise is pending. */
export const LOAD_DEMO_DATA_LOADING_LABEL = "Loading…";

/** Props for {@link DemoDataControl}. */
export interface DemoDataControlProps {
  /**
   * Invoked when the user activates the control (Req 13.2). The App wires this
   * to `demoDataLoader.load()` → `IntakeController.intake(files)`.
   *
   * May be synchronous or return a promise. When a promise is returned, the
   * control shows a loading/disabled state until it settles.
   */
  onLoadDemo: () => void | Promise<void>;
  /**
   * Optional idle label / accessible name for the button. Defaults to
   * {@link LOAD_DEMO_DATA_LABEL}. The App renders a second control with a
   * distinct label for the mismatched stitching dataset (Req 8.4), reusing this
   * same presentational component.
   */
  label?: string;
}

/**
 * The "Load demo data" button. Presentational only: it surfaces the user's
 * intent via {@link DemoDataControlProps.onLoadDemo} and manages its own
 * transient loading state, nothing more.
 */
export function DemoDataControl({
  onLoadDemo,
  label = LOAD_DEMO_DATA_LABEL,
}: DemoDataControlProps): JSX.Element {
  const [isLoading, setIsLoading] = useState(false);
  // A ref mirror of the loading flag so rapid clicks are rejected synchronously,
  // before React has re-rendered with the disabled button (double-click guard).
  const loadingRef = useRef(false);

  const handleClick = useCallback(() => {
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setIsLoading(true);

    // Normalize sync/async callbacks: Promise.resolve handles a void return,
    // a thrown synchronous error, and a returned rejected promise uniformly.
    Promise.resolve()
      .then(() => onLoadDemo())
      .finally(() => {
        loadingRef.current = false;
        setIsLoading(false);
      });
  }, [onLoadDemo]);

  return (
    <div className="frankendata-demo-control">
      <button
        type="button"
        className="frankendata-demo-control__button"
        onClick={handleClick}
        disabled={isLoading}
        aria-busy={isLoading}
      >
        {isLoading ? LOAD_DEMO_DATA_LOADING_LABEL : label}
      </button>
    </div>
  );
}

export default DemoDataControl;
