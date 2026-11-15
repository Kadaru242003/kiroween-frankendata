import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { describeEgress } from "../core/egress-description";
import { AiToggle } from "./AiToggle";

describe("AiToggle", () => {
  it("shows a static Fully local label when the build has AI disabled", () => {
    render(<AiToggle buildEnabled={false} on onChange={() => {}} />);
    expect(screen.getByText("Fully local")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "What leaves the browser?" })).toBeNull();
  });
  it("switches between AI: On and AI: Off (fully local)", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AiToggle buildEnabled on onChange={onChange} />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveTextContent("AI: On");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(false);
    rerender(<AiToggle buildEnabled on={false} onChange={onChange} />);
    expect(screen.getByRole("switch")).toHaveTextContent("AI: Off (fully local)");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
  it("lists exactly what is sent, and that rows are never sent", () => {
    render(<AiToggle buildEnabled on onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: "What leaves the browser?" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    for (const line of describeEgress().sent) expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.getByText(describeEgress().neverSent)).toBeInTheDocument();
  });
  it("closes on Esc and on an outside click", () => {
    render(<AiToggle buildEnabled on onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: "What leaves the browser?" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
