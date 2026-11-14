/**
 * Idempotent demo loading for FrankenData (bug fix: repeated demo reloads).
 *
 * The two bundled demos BOTH contain `monsters.csv` and `experiments.csv` (with
 * different content), so a file-name check cannot tell them apart. Instead this
 * tracks loading by a stable DEMO ID: once a demo's tables are loaded, clicking
 * its button again is a no-op ({@link DemoLoader.isLoaded} is true) until the
 * lab is reset (or its tables are otherwise removed), which calls
 * {@link DemoLoader.clear}. Loading the OTHER demo is always allowed.
 *
 * Framework-agnostic and side-effect-light: the loader owns only the
 * "which demos are loaded" set plus the injected intake step; the App wires the
 * real `demoDataLoader` + `IntakeController.intake` and calls `clear()` on reset.
 */

/** The bundled demos, by stable id. */
export type DemoId = "default" | "mismatched" | "nextMonth";

/** Produces the `File` objects for one demo (bundled; no network). */
export type DemoFilesProvider = () => Promise<File[]>;

/** Routes demo files through the shared intake pipeline. */
export type DemoIntake = (files: File[]) => Promise<void>;

export interface DemoLoaderDeps {
  /** Per-demo file providers (e.g. `demoDataLoader.load` / `.loadMismatched`). */
  providers: Record<DemoId, DemoFilesProvider>;
  /** The intake step (e.g. `controller.intake`). */
  intake: DemoIntake;
}

export interface DemoLoader {
  /** True once `load(id)` has succeeded and `clear()` has not been called since. */
  isLoaded(id: DemoId): boolean;
  /**
   * Load a demo's tables IF not already loaded. Returns `true` when it actually
   * loaded (so the UI can react), `false` when it was a no-op because the demo
   * is already loaded. A load failure leaves the demo marked NOT loaded (so the
   * user can retry) and rethrows nothing — it resolves `false`.
   */
  load(id: DemoId): Promise<boolean>;
  /** Forget all loaded demos (called on reset), re-enabling every button. */
  clear(): void;
}

export function createDemoLoader(deps: DemoLoaderDeps): DemoLoader {
  const loaded = new Set<DemoId>();

  return {
    isLoaded(id: DemoId): boolean {
      return loaded.has(id);
    },
    async load(id: DemoId): Promise<boolean> {
      if (loaded.has(id)) return false;
      try {
        const files = await deps.providers[id]();
        await deps.intake(files);
        loaded.add(id);
        return true;
      } catch {
        // Leave the demo un-marked so the user can retry; never throw.
        return false;
      }
    },
    clear(): void {
      loaded.clear();
    },
  };
}
