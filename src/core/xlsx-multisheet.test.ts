import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createTestLab } from "./recipes/recipe-test-lab";
import { XlsxParser } from "./xlsx-parser";

function workbookFile(sheets: Array<[string, unknown[][]]>): File {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
  return new File([bytes as BlobPart], "multi.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
const three = (): File =>
  workbookFile([
    ["Sheet1", [["a"], [1]]],
    ["Sheet2", [["b"], [2]]],
    ["Sheet3", [["c"], [3]]],
  ]);

describe("XLSX with several sheets", () => {
  it("still reads the first sheet and reports which one and how many", async () => {
    const parsed = await new XlsxParser().parse(three());
    expect(parsed.columnNames).toEqual(["a"]);
    expect(parsed.sheetNotice).toEqual({ sheetName: "Sheet1", sheetCount: 3 });
  });

  it("reports nothing for a single-sheet workbook", async () => {
    const parsed = await new XlsxParser().parse(workbookFile([["Only", [["a"], [1]]]]));
    expect(parsed.sheetNotice).toBeUndefined();
  });

  it("carries the notice onto the loaded table", async () => {
    const lab = await createTestLab();
    try {
      await lab.load([three()]);
      expect(lab.tables()[0]?.sheetNotice).toEqual({ sheetName: "Sheet1", sheetCount: 3 });
    } finally {
      await lab.dispose();
    }
  }, 60000);
});
