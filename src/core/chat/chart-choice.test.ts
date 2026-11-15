import { describe, expect, it } from "vitest";
import { chooseChart, shapeLinePoints } from "./chart-choice";

const T = new Set(["day"]);
describe("chooseChart", () => {
  it("line for temporal plus numeric, either column order", () => {
    expect(chooseChart(["day", "n"], [["2026-01-01", 1], ["2026-01-02", 2]], T)).toEqual({ type: "line", x: "day", y: "n" });
    expect(chooseChart(["n", "day"], [[1, "2026-01-01"], [2, "2026-01-02"]], T)).toEqual({ type: "line", x: "day", y: "n" });
  });
  it("needs two points for a line", () => {
    expect(chooseChart(["day", "n"], [["2026-01-01", 1]], T)).toBeUndefined();
  });
  it("bar for text plus numeric", () => {
    expect(chooseChart(["species", "n"], [["a", 1]], new Set())).toEqual({ type: "bar", x: "species", y: "n" });
  });
  it("no chart otherwise", () => {
    expect(chooseChart(["a"], [[1]], new Set())).toBeUndefined();
    expect(chooseChart(["a", "b", "c"], [["x", 1, 2]], new Set())).toBeUndefined();
    expect(chooseChart(["a", "b"], [["x", "y"]], new Set())).toBeUndefined();
    expect(chooseChart(["a", "b"], [[1, 2]], new Set())).toBeUndefined();
    expect(chooseChart(["day", "n"], [], T)).toBeUndefined();
    expect(chooseChart(["day", "day2"], [["2026-01-01", "2026-01-02"]], new Set(["day", "day2"]))).toBeUndefined();
  });
  it("empty first values are skipped when finding the numeric type", () => {
    expect(chooseChart(["species", "n"], [["a", ""], ["b", 2]], new Set())?.type).toBe("bar");
  });
});

describe("shapeLinePoints", () => {
  it("sorts by x and ignores non numeric y", () => {
    const pts = shapeLinePoints(["d", "n"], [["2026-02-01", 2], ["2026-01-01", 1], ["2026-03-01", "x"]], "d", "n");
    expect(pts).toEqual([{ label: "2026-01-01", value: 1 }, { label: "2026-02-01", value: 2 }]);
  });
  it("samples long series keeping first and last", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [`2026-${String(i).padStart(5, "0")}`, i]);
    const pts = shapeLinePoints(["d", "n"], rows as never, "d", "n", 50);
    expect(pts).toHaveLength(50);
    expect(pts[0].value).toBe(0);
    expect(pts[49].value).toBe(999);
  });
});
