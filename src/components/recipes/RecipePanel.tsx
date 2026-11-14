/**
 * RecipePanel (Feature 5): Apply recipe, Save recipe, Export SQL script, and
 * the stitched-result export. All feedback is in place through one polite live
 * region. Nothing here scrolls or moves focus; navigation to the approval
 * screen happens only from the explicit "Review in stitching table" button.
 */
import { useCallback, useRef, useState, type DragEvent, type JSX } from "react";
import type {
  NotAppliedItem,
  RecipeIssue,
} from "../../core/recipes/types";
import { RECIPE_MAX_BYTES } from "../../core/recipes/types";
import type { DuckDBService, LoadedTable } from "../../core/types";
import { ExportButtons } from "./ExportButtons";
import { RecipeNotApplied } from "./RecipeNotApplied";
import "./Recipes.css";

/** The outcome the App reports back after trying to apply a recipe. */
export type RecipeApplyOutcome =
  | { ok: true; preApproved: number; notApplied: NotAppliedItem[] }
  | { ok: false; errors: RecipeIssue[] };

/** A file the panel hands to the download helper. */
export interface PanelDownload {
  fileName: string;
  mime: string;
  text: string;
}

export interface RecipePanelProps {
  db: DuckDBService;
  /** The stitched result, or null. Save recipe and Export SQL need one. */
  stitchedTable: LoadedTable | null;
  /** Read and apply recipe text. Never throws. */
  onApplyRecipe: (text: string) => Promise<RecipeApplyOutcome>;
  /** Build the recipe JSON download, or null when there is nothing to save. */
  getRecipeDownload: () => PanelDownload | null;
  /** Build the SQL script download, or null when there is nothing to export. */
  getSqlDownload: () => PanelDownload | null;
  /** Open the approval screen (explicit navigation). */
  onReview: () => void;
  /** The last apply outcome, owned by the App so the stitch section can show it. */
  outcome: RecipeApplyOutcome | null;
  download: (fileName: string, mime: string, text: string) => void;
}

export function RecipePanel({
  db,
  stitchedTable,
  onApplyRecipe,
  getRecipeDownload,
  getSqlDownload,
  onReview,
  outcome,
  download,
}: RecipePanelProps): JSX.Element {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const applyFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setMessage("");
      try {
        if (file.size > RECIPE_MAX_BYTES) {
          const res = await onApplyRecipe("x".repeat(RECIPE_MAX_BYTES + 1));
          if (!res.ok) setMessage("That recipe is too large, so nothing was changed.");
          return;
        }
        const text = await file.text();
        const res = await onApplyRecipe(text);
        setMessage(
          res.ok
            ? `Recipe applied: ${res.preApproved} ${res.preApproved === 1 ? "proposal" : "proposals"} pre-approved, ${res.notApplied.length} not applied.`
            : "That file is not a valid recipe, so nothing was changed."
        );
      } catch {
        setMessage("The recipe file could not be read, so nothing was changed.");
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [onApplyRecipe]
  );

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void applyFile(file);
  };

  const save = (get: () => PanelDownload | null, done: (name: string) => string) => {
    const d = get();
    if (!d) {
      setMessage("There is nothing to save yet.");
      return;
    }
    download(d.fileName, d.mime, d.text);
    setMessage(done(d.fileName));
  };

  return (
    <section className="recipe-panel" aria-label="Recipes">
      <h2 className="recipe-panel__title">Recipes</h2>
      <div
        className={`recipe-panel__drop${dragging ? " recipe-panel__drop--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <label className="recipe-panel__button">
          <span>{busy ? "Reading recipe..." : "Apply recipe"}</span>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            className="recipe-panel__file"
            aria-label="Apply recipe (JSON file)"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void applyFile(f);
            }}
          />
        </label>
        <span className="recipe-panel__hint">
          Choose or drop a recipe .json. It is checked first and never stitches on its own.
        </span>
      </div>

      {stitchedTable !== null ? (
        <div className="recipe-panel__actions">
          <button
            type="button"
            className="recipe-panel__button"
            onClick={() => save(getRecipeDownload, (n) => `Saved ${n}`)}
          >
            Save recipe
          </button>
          <button
            type="button"
            className="recipe-panel__button"
            onClick={() => save(getSqlDownload, (n) => `Saved ${n}`)}
          >
            Export SQL script
          </button>
          <ExportButtons db={db} table={stitchedTable} />
        </div>
      ) : null}

      <p className="recipe-panel__message" role="status" aria-live="polite">
        {message}
      </p>

      {outcome && !outcome.ok ? (
        <div className="recipe-panel__errors" role="alert">
          <p className="recipe-panel__errors-title">Problems found in the recipe:</p>
          <ul>
            {outcome.errors.slice(0, 5).map((e, i) => (
              <li key={`${e.path}-${i}`}>
                <code>{e.path}</code> {e.message}
              </li>
            ))}
          </ul>
          {outcome.errors.length > 5 ? (
            <p>And {outcome.errors.length - 5} more.</p>
          ) : null}
        </div>
      ) : null}

      {outcome && outcome.ok ? (
        <div className="recipe-panel__result">
          <p>
            {outcome.preApproved} {outcome.preApproved === 1 ? "proposal" : "proposals"} pre-approved,{" "}
            {outcome.notApplied.length} not applied.
          </p>
          <button type="button" className="recipe-panel__button" onClick={onReview}>
            Review in stitching table
          </button>
          <RecipeNotApplied items={outcome.notApplied} />
        </div>
      ) : null}
    </section>
  );
}

export default RecipePanel;
