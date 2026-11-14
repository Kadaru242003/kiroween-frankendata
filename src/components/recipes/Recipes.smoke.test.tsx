import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DuckDBService, LoadedTable } from "../../core/types";
import { applyRecipeText } from "../../core/recipes/recipe-apply";
import { EXPERIMENTS, MONSTERS, proposalSet, validRecipe } from "../../core/recipes/recipe-test-support";
import { StitchStore } from "../../core/stitching/stitch-store";
import { ExportButtons } from "./ExportButtons";
import { RecipePanel, type RecipeApplyOutcome } from "./RecipePanel";

const db = {} as DuckDBService;
const table = { tableName: "monsters", schema: MONSTERS.schema, rowCount: 3 };

describe("ExportButtons", () => {
  it("exports in place, shows feedback, and never scrolls", async () => {
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    window.scrollTo = scrollTo as never;
    Element.prototype.scrollIntoView = scrollIntoView;
    const exporter = vi.fn(async () => ({ fileName: "monsters.csv", mime: "text/csv", data: "a,b" }));
    const download = vi.fn();
    render(<ExportButtons db={db} table={table} exporter={exporter} download={download} />);
    fireEvent.click(screen.getByRole("button", { name: "Export monsters as CSV" }));
    await waitFor(() => expect(screen.getByText("Exported monsters.csv")).toBeInTheDocument());
    expect(exporter).toHaveBeenCalledWith(db, table, "csv");
    expect(download).toHaveBeenCalledWith("monsters.csv", "text/csv", "a,b");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export monsters as Excel" })).toBeEnabled();
  });
  it("shows a clear message when the export fails", async () => {
    const exporter = vi.fn(async () => {
      throw new Error("Could not export monsters: boom");
    });
    render(<ExportButtons db={db} table={table} exporter={exporter} download={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Export monsters as Parquet" }));
    await waitFor(() => expect(screen.getByText("Could not export monsters: boom")).toBeInTheDocument());
  });
});

function panel(props: Partial<React.ComponentProps<typeof RecipePanel>> = {}) {
  return (
    <RecipePanel
      db={db}
      stitchedTable={null}
      onApplyRecipe={async () => ({ ok: true, preApproved: 0, notApplied: [] })}
      getRecipeDownload={() => null}
      getSqlDownload={() => null}
      onReview={() => {}}
      outcome={null}
      download={() => {}}
      {...props}
    />
  );
}
const stitched: LoadedTable = { ...EXPERIMENTS, tableName: "stitch_1_result" };

describe("RecipePanel", () => {
  it("shows Save recipe and Export SQL only when a stitched result exists", () => {
    const { rerender } = render(panel());
    expect(screen.queryByRole("button", { name: "Save recipe" })).toBeNull();
    rerender(panel({ stitchedTable: stitched }));
    expect(screen.getByRole("button", { name: "Save recipe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export SQL script" })).toBeInTheDocument();
  });

  it("saves through the download helper and confirms in place", () => {
    const download = vi.fn();
    render(
      panel({
        stitchedTable: stitched,
        download,
        getRecipeDownload: () => ({ fileName: "r.json", mime: "application/json", text: "{}" }),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    expect(download).toHaveBeenCalledWith("r.json", "application/json", "{}");
    expect(screen.getByText("Saved r.json")).toBeInTheDocument();
  });

  it("an invalid recipe upload shows errors and changes nothing", async () => {
    const store = new StitchStore();
    store.setProposals(proposalSet(), "v1", false);
    const before = store.getState();
    const compute = vi.fn(async () => proposalSet());
    let outcome: RecipeApplyOutcome | null = null;
    const onApplyRecipe = vi.fn(async (text: string) => {
      const res = await applyRecipeText(text, {
        tables: [MONSTERS, EXPERIMENTS],
        store,
        computeProposals: compute,
      });
      outcome = res.ok
        ? { ok: true as const, preApproved: res.mapping.mappedCount, notApplied: res.mapping.notApplied }
        : { ok: false as const, errors: res.errors };
      return outcome;
    });
    const { rerender } = render(panel({ onApplyRecipe }));
    const input = screen.getByLabelText("Apply recipe (JSON file)");
    const file = new File(['{"format":"nope"}'], "bad.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onApplyRecipe).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/not a valid recipe/)).toBeInTheDocument());
    rerender(panel({ onApplyRecipe, outcome }));
    expect(screen.getByRole("alert")).toHaveTextContent("Problems found in the recipe");
    expect(store.getState()).toBe(before);
    expect(compute).not.toHaveBeenCalled();
  });

  it("lists items that were not applied with their reasons and offers an explicit review button", () => {
    const onReview = vi.fn();
    render(
      panel({
        onReview,
        outcome: {
          ok: true,
          preApproved: 2,
          notApplied: [
            { kind: "cleaning", description: 'Cleanup "category" on monsters.Species', code: "no-longer-detected", reason: "Nothing to clean here in the current data." },
          ],
        },
      })
    );
    expect(screen.getByText("Not applied (1)")).toBeInTheDocument();
    expect(screen.getByText('Cleanup "category" on monsters.Species')).toBeInTheDocument();
    expect(screen.getByText("Nothing to clean here in the current data.")).toBeInTheDocument();
    expect(screen.getByText(/2 proposals pre-approved, 1 not applied/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review in stitching table" }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid recipe through the real apply path (nothing is stitched)", async () => {
    const store = new StitchStore();
    const res = await applyRecipeText(JSON.stringify(validRecipe()), {
      tables: [MONSTERS, EXPERIMENTS],
      store,
      computeProposals: async () => proposalSet(),
    });
    expect(res.ok).toBe(true);
    expect(store.getState().stitchedTable).toBeNull();
    expect(Object.keys(store.getState().decisions)).toHaveLength(3);
  });
});
