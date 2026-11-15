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

describe("canonical tie-break for emails, URLs and identifiers", () => {
  it("prefers the all-lowercase variant when one exists", () => {
    expect(
      mostFrequentSurfaceForm([e("Jane.Doe@Northwind-Analytics.Example"), e("jane.doe@northwind-analytics.example")])
    ).toBe("jane.doe@northwind-analytics.example");
    expect(mostFrequentSurfaceForm([e("HTTPS://Example.com/A"), e("https://example.com/a")])).toBe("https://example.com/a");
    expect(mostFrequentSurfaceForm([e("Order_Id_42"), e("order_id_42"), e("ORDER_ID_42")])).toBe("order_id_42");
    expect(mostFrequentSurfaceForm([e("Acme.Corp"), e("acme.corp")])).toBe("acme.corp");
  });
  it("still takes the most frequent variant, and the best of the rest when there is no lowercase one", () => {
    expect(mostFrequentSurfaceForm([e("Jane.Doe@X.Example", 2), e("jane.doe@x.example", 1)])).toBe("Jane.Doe@X.Example");
    expect(mostFrequentSurfaceForm([e("JANE.DOE@X.EXAMPLE"), e("Jane.Doe@X.Example")])).toBe("JANE.DOE@X.EXAMPLE");
  });
  it("keeps Title Case for name-like text", () => {
    expect(caseShapeRank("jane doe")).toBe(2);
    expect(mostFrequentSurfaceForm([e("jane doe"), e("Jane Doe")])).toBe("Jane Doe");
    expect(mostFrequentSurfaceForm([e("swamp"), e("Swamp")])).toBe("Swamp");
    expect(mostFrequentSurfaceForm([e("Jean-Luc"), e("jean-luc")])).toBe("Jean-Luc");
  });
  it("ranks a lowercase identifier first and leaves digits-only text alone", () => {
    expect(caseShapeRank("jane.doe@x.example")).toBe(0);
    expect(caseShapeRank("Jane.Doe@X.Example")).toBe(2);
    expect(caseShapeRank("123")).toBe(2);
  });
});
