import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import type { DuckDBService } from "../types";
import {
  exportFileName,
  exportTable,
  readTable,
  toCsvText,
  toXlsxBytes,
} from "./table-exporter";

const schema = [
  { name: "name", type: "string" as const },
  { name: "n", type: "number" as const },
  { name: "ok", type: "boolean" as const },
  { name: "d", type: "date" as const },
];
function fakeDb(rows: Record<string, unknown>[]): DuckDBService & { sqls: string[] } {
  const sqls: string[] = [];
  return {
    sqls,
    init: async () => {},
    createTable: async () => {
      throw new Error("unused");
    },
    getRowCount: async () => rows.length,
    getPreviewRows: async () => [],
    query: (async (sql: string) => {
      sqls.push(sql);
      return rows;
    }) as DuckDBService["query"],
  };
}
const ROWS = [
  { name: 'Gor, "zak"\nline', n: 1234.5, ok: true, d: "2026-01-05" },
  { name: null, n: null, ok: false, d: null },
  { name: "Wisp", n: 10n, ok: null, d: "2025-12-25" },
];

describe("exportFileName", () => {
  it("keeps only safe characters and falls back to table", () => {
    expect(exportFileName("monsters", "csv")).toBe("monsters.csv");
    expect(exportFileName("../a b/c.d", "xlsx")).toBe("a_b_c_d.xlsx");
    expect(exportFileName("???", "xlsx")).toBe("table.xlsx");
  });
});

describe("readTable and CSV", () => {
  it("reads the full table, casting dates to VARCHAR and quoting identifiers", async () => {
    const db = fakeDb(ROWS);
    const data = await readTable(db, { tableName: 'we"ird', schema });
    expect(db.sqls[0]).toBe(
      'SELECT "name", "n", "ok", CAST("d" AS VARCHAR) AS "d" FROM "we""ird"'
    );
    expect(data.rows[2][1]).toBe(10);
    expect(data.rows[1]).toEqual([null, null, false, null]);
  });
  it("writes RFC 4180 CSV with NULL as empty fields", async () => {
    const f = await exportTable(fakeDb(ROWS), { tableName: "t", schema, rowCount: 3 }, "csv");
    expect(f.fileName).toBe("t.csv");
    expect(f.mime).toBe("text/csv");
    expect(f.data).toBe(
      ['name,n,ok,d', '"Gor, ""zak""\nline",1234.5,true,2026-01-05', ',,false,', "Wisp,10,,2025-12-25"].join("\r\n")
    );
  });
  it("toCsvText handles an empty table", () => {
    expect(toCsvText(["a"], [])).toBe("a");
  });
});

describe("Excel", () => {
  it("writes typed cells readable by SheetJS", async () => {
    const data = await readTable(fakeDb(ROWS), { tableName: "t", schema });
    const bytes = toXlsxBytes("my:sheet/name", data);
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    expect(wb.SheetNames[0]).toBe("my_sheet_name");
    const ws = wb.Sheets[wb.SheetNames[0]];
    expect(ws["A1"].v).toBe("name");
    expect(ws["B2"].t).toBe("n");
    expect(ws["B2"].v).toBe(1234.5);
    expect(ws["C2"].t).toBe("b");
    expect(ws["D2"].t).toBe("d");
    expect(ws["A3"]).toBeUndefined();
  });
  it("refuses a table beyond the Excel row limit with a clear message", async () => {
    await expect(
      exportTable(fakeDb([]), { tableName: "big", schema, rowCount: 2_000_000 }, "xlsx")
    ).rejects.toThrow(/Excel files hold at most/);
  });
});
