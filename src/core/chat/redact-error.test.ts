import { describe, expect, it } from "vitest";
import { ASK_REPAIR_ERROR_MAX_CHARS } from "./types";
import { redactDuckDbError } from "./redact-error";

describe("redactDuckDbError", () => {
  it("redacts the value in a conversion error and keeps the error type and message", () => {
    const raw =
      "Conversion Error: Could not convert string 'N/A-4821' to INT32 when casting from source column \"containment_cost\"\n" +
      "LINE 1: SELECT CAST(containment_cost AS INTEGER) FROM monsters\n" +
      "                    ^";
    const out = redactDuckDbError(raw);
    expect(out).toBe(
      "Conversion Error: Could not convert string '<value>' to INT32 when casting from source column '<value>'"
    );
    expect(out).not.toContain("N/A-4821");
    expect(out).not.toContain("LINE 1");
  });

  it("keeps only the first line (type and message)", () => {
    const out = redactDuckDbError("Binder Error: Referenced column x not found\nCandidate bindings: a, b\nLINE 1: ...");
    expect(out).toBe("Binder Error: Referenced column x not found");
  });

  it("replaces single-quoted, double-quoted and escaped-quote values", () => {
    expect(redactDuckDbError("Error: bad 'O''Brien' here")).toBe("Error: bad '<value>' here");
    expect(redactDuckDbError('Error: bad "col ""x""" here')).toBe("Error: bad '<value>' here");
    expect(redactDuckDbError("Error: a 'x' b 'y' c")).toBe("Error: a '<value>' b '<value>' c");
  });

  it("does not leak a value that itself contains a quote", () => {
    const out = redactDuckDbError("Conversion Error: Could not convert string 'O'Brien' to INT32");
    expect(out).toBe("Conversion Error: Could not convert string '<value>' to INT32");
    expect(out).not.toContain("Brien");
  });

  it("treats an apostrophe inside a word as text, not as a quote", () => {
    const out = redactDuckDbError("Conversion Error: Type INT64 can't be cast because 'abc' is bad");
    expect(out).toBe("Conversion Error: Type INT64 can't be cast because '<value>' is bad");
  });

  it("redacts from an unterminated quote to the end", () => {
    const out = redactDuckDbError("Conversion Error: Could not convert string 'abc to INT32");
    expect(out).toBe("Conversion Error: Could not convert string '<value>'");
    expect(out).not.toContain("abc");
  });

  it("masks bare numbers (an out-of-range cast prints the value) but not type names", () => {
    const out = redactDuckDbError(
      "Conversion Error: Type INT64 with value 3000000000 can't be cast because the value is out of range for the destination type INT32"
    );
    expect(out).not.toContain("3000000000");
    expect(out).toContain("INT64");
    expect(out).toContain("INT32");
    expect(out).toContain("<number>");
  });

  it("caps the result at ASK_REPAIR_ERROR_MAX_CHARS", () => {
    const out = redactDuckDbError("Parser Error: " + "word ".repeat(500));
    expect(out.length).toBeLessThanOrEqual(ASK_REPAIR_ERROR_MAX_CHARS);
    expect(ASK_REPAIR_ERROR_MAX_CHARS).toBe(300);
  });

  it("returns a plain label when nothing is left", () => {
    expect(redactDuckDbError("")).toBe("Error");
    expect(redactDuckDbError("\n\n")).toBe("Error");
  });

  it("passes an error without values through unchanged", () => {
    expect(redactDuckDbError("Parser Error: syntax error at or near FROM")).toBe(
      "Parser Error: syntax error at or near FROM"
    );
  });
});
