import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineChart } from "./LineChart";

const spec = { type: "line" as const, x: "day", y: "n" };
describe("LineChart", () => {
  it("draws a polyline, points, and a hidden data table sorted by x", () => {
    const { container } = render(
      <LineChart spec={spec} columns={["day", "n"]} rows={[["2026-01-02", 3], ["2026-01-01", 1], ["2026-01-03", 2]]} />
    );
    expect(screen.getByLabelText("Line chart of n over day")).toBeInTheDocument();
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(container.querySelectorAll("circle")).toHaveLength(3);
    const cells = Array.from(container.querySelectorAll("tbody td")).map((c) => c.textContent);
    expect(cells).toEqual(["2026-01-01", "1", "2026-01-02", "3", "2026-01-03", "2"]);
    expect(container.querySelector("svg")?.getAttribute("role")).toBe("img");
  });
  it("renders nothing for fewer than two points and treats labels as text", () => {
    const { container } = render(<LineChart spec={spec} columns={["day", "n"]} rows={[["<b>x</b>", 1]]} />);
    expect(container.firstChild).toBeNull();
    const two = render(<LineChart spec={spec} columns={["day", "n"]} rows={[["<b>a</b>", 1], ["<b>b</b>", 2]]} />);
    expect(two.container.querySelector("b")).toBeNull();
  });
});
