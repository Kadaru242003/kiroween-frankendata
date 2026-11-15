import { describe, expect, it } from "vitest";
import { describeEgress } from "./egress-description";

describe("What leaves the browser?", () => {
  it("says that a failed query sends its error message with values removed", () => {
    expect(describeEgress().sent).toContain("If a query fails, the error message with values removed.");
  });
  it("still says rows and result values are never sent", () => {
    expect(describeEgress().neverSent).toMatch(/rows are never sent/);
    expect(describeEgress().neverSent).toMatch(/result values/);
  });
});
