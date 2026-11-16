// @vitest-environment node
/**
 * Excel date cells are calendar dates with no time zone. A user in any time zone
 * must see the date that Excel shows: 2026-01-05 is 2026-01-05 in Berlin, Tokyo,
 * Kolkata, Auckland and Los Angeles. SheetJS builds each Date so its LOCAL
 * fields equal the sheet's, so the parser must read the local fields.
 */
import * as XLSX from "xlsx";
import { afterEach, describe, expect, it } from "vitest";
import { XlsxParser } from "./xlsx-parser";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** A workbook the way Excel writes dates: whole-number serials with a date format. */
function excelDates(serials: number[], format: string): File {
  const ws = XLSX.utils.aoa_to_sheet([["d"], ...serials.map((s) => [s])]) as XLSX.WorkSheet;
  serials.forEach((_, i) => {
    (ws[`A${i + 2}`] as XLSX.CellObject).z = format;
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "S");
  return new File([XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer], "dates.xlsx");
}

const ZONES: Array<[string, number]> = [
  ["UTC", 0],
  ["America/Los_Angeles", 480],
  ["Europe/Berlin", -60],
  ["Asia/Kolkata", -330],
  ["Asia/Tokyo", -540],
  ["Pacific/Auckland", -780],
];

describe("XLSX date cells are the same calendar date in every time zone", () => {
  for (const [zone, expectedOffsetJan] of ZONES) {
    it(`midnight serials in ${zone}`, async () => {
      process.env.TZ = zone;
      // The runtime must really have switched zone, or this test proves nothing.
      expect(new Date(2026, 0, 5).getTimezoneOffset()).toBe(expectedOffsetJan);
      // 46027 = 2026-01-05, 46387 = 2026-12-31, 25569 = 1970-01-01, 45000 = 2023-03-15
      const parsed = await new XlsxParser().parse(excelDates([46027, 46387, 25569, 45000], "yyyy-mm-dd"));
      expect(parsed.rows.map((r) => r[0])).toEqual(["2026-01-05", "2026-12-31", "1970-01-01", "2023-03-15"]);
    });

    it(`date and time serials keep their calendar day in ${zone}`, async () => {
      process.env.TZ = zone;
      // 45000.75 = 2023-03-15 18:00, 45000.999 = 2023-03-15 23:58
      const parsed = await new XlsxParser().parse(excelDates([45000.75, 45000.999, 45000.25], "yyyy-mm-dd hh:mm"));
      expect(parsed.rows.map((r) => r[0])).toEqual(["2023-03-15", "2023-03-15", "2023-03-15"]);
    });
  }
});
