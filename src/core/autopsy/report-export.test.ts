/**
 * Unit tests for the Autopsy Markdown and JSON export (Feature 4, task 6).
 * Requirements 6.1 to 6.5.
 */

import { describe, expect, it } from "vitest";
import { escapeMarkdown, toJson, toMarkdown } from "./report-export";
import { assembleReport, buildColumnFinding } from "./autopsy-engine";
import type { AutopsyReport } from "./types";

function sample(tableName = "monsters", colName = "Species"): AutopsyReport {
  const target = { tableName, schema: [{ name: colName, type: "string" as const }], rowCount: 14 };
  return assembleReport({
    target,
    rows: 14,
    columns: [
      buildColumnFinding({ name: colName, type: "string" }, 14, { nonNull: 14, distinct: 6 }, {
        topValues: [{ value: "Swamp Wraith", count: 4 }],
        whitespaceRows: 1,
        caseVariantGroups: 2,
      }),
    ],
    duplicateRows: 2,
    fixes: [],
    complete: true,
  });
}

describe("toJson", () => {
  it("round trips to an equivalent report", () => {
    const r = sample();
    expect(JSON.parse(toJson(r))).toEqual(r);
  });
});

describe("toMarkdown", () => {
  it("contains the score, breakdown, table findings, and columns", () => {
    const md = toMarkdown(sample());
    expect(md).toContain("# Autopsy case file: monsters");
    expect(md).toContain("Health score: **");
    expect(md).toContain("## Score breakdown");
    expect(md).toContain("Exact duplicate rows: 2");
    expect(md).toContain("| Species | string |");
    expect(md).toContain("Top values: Swamp Wraith (4)");
  });

  it("renders a message-only document for a non-ok report", () => {
    const r = { ...sample(), status: "too-large" as const, message: "Too big" };
    const md = toMarkdown(r);
    expect(md).toContain("Status: too-large");
    expect(md).toContain("Too big");
    expect(md).not.toContain("## Columns");
  });

  it("escapes hostile names so data cannot add headings, rows, or HTML", () => {
    const md = toMarkdown(sample("# evil\n## heading", "a | b <script>x</script>"));
    // No injected heading or table row starts a line.
    expect(md.split("\n").some((l) => /^## heading/.test(l))).toBe(false);
    expect(md).not.toContain("<script>");
    expect(md).toContain("&lt;script");
    // The pipe inside the name is escaped, so the table keeps its shape.
    const row = md.split("\n").find((l) => l.startsWith("| a"));
    expect(row).toContain("a \\| b");
  });
});

describe("escapeMarkdown", () => {
  it("escapes structural characters and flattens newlines", () => {
    expect(escapeMarkdown("a*b_c")).toBe("a\\*b\\_c");
    expect(escapeMarkdown("x\ny")).toBe("x y");
    expect(escapeMarkdown("<b>")).toBe("&lt;b\\>");
  });
});
