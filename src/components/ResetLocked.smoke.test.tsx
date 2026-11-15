import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DemoDataControl } from "./DemoDataControl";
import { DropZone } from "./DropZone";
import { ApplyRecipe } from "./recipes/RecipePanel";

describe("controls disabled while Reset lab runs", () => {
  it("DemoDataControl does not load when disabled", () => {
    const onLoad = vi.fn();
    render(<DemoDataControl onLoadDemo={onLoad} disabled />);
    const b = screen.getByRole("button", { name: "Load demo data" });
    expect(b).toBeDisabled();
    fireEvent.click(b);
    expect(onLoad).not.toHaveBeenCalled();
  });
  it("DropZone ignores files and the browse button is disabled", () => {
    const onFiles = vi.fn();
    const { container } = render(<DropZone onFiles={onFiles} disabled />);
    expect(screen.getByRole("button", { name: "Browse files" })).toBeDisabled();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["a"], "a.csv")] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
  it("Apply recipe is disabled", () => {
    render(<ApplyRecipe onApplyRecipe={async () => ({ ok: true, preApproved: 0, notApplied: [] })} onReview={() => {}} outcome={null} disabled />);
    expect(screen.getByLabelText("Apply recipe (JSON file)")).toBeDisabled();
  });
  it("controls work when not disabled", async () => {
    const onLoad = vi.fn();
    render(<DemoDataControl onLoadDemo={onLoad} />);
    fireEvent.click(screen.getByRole("button", { name: "Load demo data" }));
    await waitFor(() => expect(onLoad).toHaveBeenCalled());
  });
});
