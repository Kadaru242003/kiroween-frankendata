import { describe, expect, it } from "vitest";
import { caseShapeRank, mostFrequentSurfaceForm } from "./cleaning-rules";

const e = (value: string, count = 1) => ({ value, count });

describe("canonical tie-break", () => {
  it("ranks Title Case over other mixed case over ALL CAPS and all lowercase", () => {
    expect(caseShapeRank("Northwind Analytics")).toBe(0);
    expect(caseShapeRank("Cedar & Pine Health")).toBe(0);
    expect(caseShapeRank("NORTHWIND Analytics")).toBe(1);
    expect(caseShapeRank("McDonald")).toBe(1);
    expect(caseShapeRank("NORTHWIND ANALYTICS")).toBe(2);
    expect(caseShapeRank("northwind analytics")).toBe(2);
    expect(caseShapeRank("123")).toBe(2);
  });
  it("Northwind Analytics wins a three-way tie", () => {
    expect(
      mostFrequentSurfaceForm([e("NORTHWIND Analytics"), e("northwind analytics"), e("Northwind Analytics")])
    ).toBe("Northwind Analytics");
  });
  it("frequency still wins over case shape", () => {
    expect(mostFrequentSurfaceForm([e("Bog Hag", 1), e("BOG HAG", 2)])).toBe("BOG HAG");
  });
  it("falls back to the lexicographic order among equal shapes", () => {
    expect(mostFrequentSurfaceForm([e("b b"), e("a a")])).toBe("a a");
    expect(mostFrequentSurfaceForm([e("Swamp Wraith"), e("Swamp wraith")])).toBe("Swamp Wraith");
  });
  it("a single entry is returned as is", () => {
    expect(mostFrequentSurfaceForm([e("X")])).toBe("X");
  });
});
