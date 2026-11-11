/**
 * Unit tests for CSV export (Feature 3, task 3).
 *
 * Covers design "CSV export" and Requirements 7.5, 7.6: header + full rows,
 * RFC-4180 quoting of commas/quotes/newlines, CRLF line endings.
 */

import { describe, expect, it } from "vitest";
import { toCsv } from "./csv-export";

describe("toCsv", () => {
  it("emits a header then every row (full result, not the display cap)", () => {
    const rows = Array.from({ length: 150 }, (_, i) => [i, `r${i}`]);
    const csv = toCsv(["n", "label"], rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("n,label");
    expect(lines).toHaveLength(151); // header + 150 rows
    expect(lines[150]).toBe("149,r149");
  });

  it("quotes fields containing a comma", () => {
    expect(toCsv(["a"], [["x,y"]])).toBe('a\r\n"x,y"');
  });

  it("quotes and doubles embedded quotes", () => {
    expect(toCsv(["a"], [['he said "hi"']])).toBe('a\r\n"he said ""hi"""');
  });

  it("quotes fields containing newlines", () => {
    expect(toCsv(["a"], [["line1\nline2"]])).toBe('a\r\n"line1\nline2"');
  });

  it("does not quote plain fields", () => {
    expect(toCsv(["a", "b"], [["x", "y"]])).toBe("a,b\r\nx,y");
  });

  it("serializes numbers and booleans", () => {
    expect(toCsv(["n", "ok"], [[42, true]])).toBe("n,ok\r\n42,true");
  });

  it("quotes a header that itself needs quoting", () => {
    expect(toCsv(["a,b"], [["x"]])).toBe('"a,b"\r\nx');
  });
});
