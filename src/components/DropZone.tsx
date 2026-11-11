/**
 * DropZone (task 15.1) — the lab "intake port" for dragged-and-dropped files.
 *
 * This is a presentational React component, deliberately decoupled from the
 * core pipeline: it never imports or instantiates DuckDB, the parsers, or the
 * {@link IntakeController}. Instead it reports the files the user provides
 * through a single `onFiles(files: File[])` callback. The App wires that
 * callback to `IntakeController.intake` (task 19.1). Keeping the component this
 * thin lets it be unit- and property-tested (task 15.2) without the DuckDB
 * stack.
 *
 * ## Behavior
 *
 * - Drag feedback (Req 1.1): `dragenter`/`dragover` call `preventDefault` and
 *   turn on a drag-over highlight; `dragleave`/`drop` clear it. The highlight is
 *   exposed as the `frankendata-dropzone--dragging` class so task 14.2 can style
 *   it; detailed styling is out of scope here.
 * - Accept everything (Req 1.2): on `drop`, every file in
 *   `dataTransfer.files` is forwarded to `onFiles` regardless of count. The
 *   component never rejects files.
 * - Guidance (Req 1.3): after the most recent drop (or browse) the informational
 *   "2 to 4 files is the intended range" message is shown **iff** the count is
 *   outside the 2–4 range (see {@link isOutsideIntendedRange}). This is purely
 *   informational — the files are still accepted and forwarded.
 * - Accessibility: the drop region carries a `button` role, a label, and is
 *   keyboard-focusable; Enter/Space and a visible "Browse files" control open a
 *   hidden `<input type="file">` whose selection is routed through the same
 *   `onFiles` path.
 */

import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
} from "react";

import "./DropZone.css";

/** The intended number of files, inclusive, for the guidance message (Req 1.3). */
export const INTENDED_FILE_RANGE = { min: 2, max: 4 } as const;

/** The informational guidance copy shown when the count is outside 2–4 (Req 1.3). */
export const FILE_COUNT_GUIDANCE_MESSAGE = "2 to 4 files is the intended range.";

/**
 * Whether a dropped-file count falls outside the intended 2–4 range.
 *
 * Pure helper exported so the guidance behavior can be exercised directly by
 * the property test (task 15.2): the message is shown if and only if this
 * returns `true`. A count of `0` (nothing meaningful dropped yet) is treated as
 * inside the range so the guidance does not appear before the user drops
 * anything.
 *
 * @param count The number of files in the most recent drop/selection.
 * @returns `true` when `count` is `1` or greater than `4`; `false` for `0` or
 *   any count within `2..4`.
 */
export function isOutsideIntendedRange(count: number): boolean {
  if (count <= 0) {
    return false;
  }
  return count < INTENDED_FILE_RANGE.min || count > INTENDED_FILE_RANGE.max;
}

/** Props for {@link DropZone}. */
export interface DropZoneProps {
  /**
   * Called with every file the user drops or selects, regardless of count
   * (Req 1.2). The App wires this to `IntakeController.intake`.
   */
  onFiles: (files: File[]) => void;
}

/**
 * The lab intake-port drop target. Presentational only: it surfaces dropped and
 * browsed files via {@link DropZoneProps.onFiles} and renders the file-count
 * guidance message, nothing more.
 */
export function DropZone({ onFiles }: DropZoneProps): JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  // The count from the most recent drop/selection, used only to decide whether
  // to render the guidance message. `null` means nothing has been provided yet.
  const [lastDropCount, setLastDropCount] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Forward a file list to the consumer and record its count for guidance. */
  const forwardFiles = useCallback(
    (fileList: FileList | null): void => {
      const files = fileList ? Array.from(fileList) : [];
      setLastDropCount(files.length);
      // Accept every file regardless of count (Req 1.2).
      onFiles(files);
    },
    [onFiles]
  );

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    // preventDefault is required for the element to be a valid drop target.
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);
      forwardFiles(event.dataTransfer?.files ?? null);
    },
    [forwardFiles]
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFilePicker();
      }
    },
    [openFilePicker]
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      forwardFiles(event.target.files);
      // Reset so selecting the same file(s) again still fires a change event.
      event.target.value = "";
    },
    [forwardFiles]
  );

  const showGuidance =
    lastDropCount !== null && isOutsideIntendedRange(lastDropCount);

  const className = `frankendata-dropzone${
    isDragging ? " frankendata-dropzone--dragging" : ""
  }`;

  return (
    <div className="frankendata-dropzone-wrapper">
      <div
        className={className}
        role="button"
        tabIndex={0}
        aria-label="File intake port. Drag and drop CSV or XLSX files here, or activate to browse."
        data-dragging={isDragging}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={openFilePicker}
        onKeyDown={handleKeyDown}
      >
        <p className="frankendata-dropzone__headline">
          Drop CSV or XLSX files into the intake port
        </p>
        <p className="frankendata-dropzone__hint">
          {isDragging ? "Release to feed the lab" : "or browse to select files"}
        </p>
        <button
          type="button"
          className="frankendata-dropzone__browse"
          onClick={(event) => {
            // Avoid double-triggering via the wrapper's onClick.
            event.stopPropagation();
            openFilePicker();
          }}
        >
          Browse files
        </button>
      </div>

      {showGuidance ? (
        <p className="frankendata-dropzone__guidance" role="status">
          {FILE_COUNT_GUIDANCE_MESSAGE}
        </p>
      ) : null}

      <input
        ref={fileInputRef}
        className="frankendata-dropzone__input"
        type="file"
        multiple
        accept=".csv,.xlsx"
        onChange={handleInputChange}
        // Visually hidden but still reachable programmatically.
        style={{ display: "none" }}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

export default DropZone;
