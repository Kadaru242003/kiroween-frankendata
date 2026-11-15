import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DemoMenu } from "./DemoMenu";

const items = [
  { id: "business", label: "Business", loaded: false },
  { id: "default", label: "Lab", loaded: true },
  { id: "mismatched", label: "Mismatched", loaded: false },
  { id: "nextMonth", label: "Next month's files", loaded: false },
];
describe("DemoMenu", () => {
  it("lists the four demos, disables loaded ones, selects, and closes on Esc", () => {
    const onSelect = vi.fn();
    render(<DemoMenu items={items} onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: /Load demo/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Business", "Lab (loaded)", "Mismatched", "Next month's files",
    ]);
    expect(screen.getByRole("menuitem", { name: /Lab/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Business" }));
    expect(onSelect).toHaveBeenCalledWith("business");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
