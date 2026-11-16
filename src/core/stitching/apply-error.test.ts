import { describe, expect, it } from "vitest";
import { describeApplyError } from "./apply-error";

describe("describeApplyError", () => {
  it("names a category and never repeats the raw message", () => {
    const secret = "Could not convert string 'TOP-SECRET-9931' to DOUBLE";
    const out = describeApplyError(new Error(secret));
    expect(out).toContain("Nothing was changed.");
    expect(out).toContain("different types");
    expect(out).not.toContain("TOP-SECRET");
  });
  it("covers memory and unknown errors, and non-Error values", () => {
    expect(describeApplyError(new Error("Out of Memory Error"))).toContain("out of memory");
    expect(describeApplyError("weird")).toContain("unexpected");
    expect(describeApplyError(undefined)).toContain("Nothing was changed.");
  });
});
