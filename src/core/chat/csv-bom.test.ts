import { describe, expect, it } from "vitest";
import { CsvParser } from "../csv-parser";
import { toCsvText } from "../recipes/table-exporter";
import { CSV_BOM, csvWithBom } from "./csv-export";

const parse = (text: string) =>
  new CsvParser().parse(new File([text], "t.csv", { type: "text/csv" }));

describe("csvWithBom", () => {
  it("adds one BOM, and only once", () => {
    expect(csvWithBom("a\r\n1")).toBe(`${CSV_BOM}a\r\n1`);
    expect(csvWithBom(csvWithBom("a"))).toBe(`${CSV_BOM}a`);
  });

  it("round-trips accented text through the app's own CSV intake", async () => {
    const columns = ["name", "city"];
    const rows = [
      ["José", "São Paulo"],
      ["Jürgen", "Zürich"],
    ];
    const text = csvWithBom(toCsvText(columns, rows));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const parsed = await parse(text);
    expect(parsed.columnNames).toEqual(columns);
    expect(parsed.rows).toEqual(rows);
  });
});
