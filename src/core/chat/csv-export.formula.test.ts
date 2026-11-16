import { describe, expect, it } from "vitest";
import { toCsvText } from "../recipes/table-exporter";
import { toCsv } from "./csv-export";

describe("CSV formula injection is neutralised", () => {
  it("prefixes text cells that start with = + - @ tab or CR", () => {
    const csv = toCsv(["a"], [["=1+1"], ["+cmd|' /C calc'!A0"], ["-2+3"], ["@SUM(1)"], ["\tx"], ["\rx"]]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("'=1+1");
    expect(lines[2]).toBe(`'+cmd|' /C calc'!A0`);
    expect(lines[3]).toBe("'-2+3");
    expect(lines[4]).toBe("'@SUM(1)");
    expect(csv).toContain("'\tx");
    expect(csv).toContain(`"'\rx"`);
  });

  it("neutralises headers too", () => {
    expect(toCsv(["=evil", "ok"], [["a", "b"]]).split("\r\n")[0]).toBe("'=evil,ok");
  });

  it("leaves numbers, booleans and numeric text unchanged", () => {
    expect(toCsv(["n", "b", "s"], [[-5, true, "-1.5"]])).toBe("n,b,s\r\n-5,true,-1.5");
    expect(toCsv(["s"], [["-12345678901234567890"]])).toBe("s\r\n-12345678901234567890");
  });

  it("keeps negative numbers unprefixed through the table exporter", () => {
    expect(toCsvText(["n", "s"], [[-5, "=1+1"]])).toBe("n,s\r\n-5,'=1+1");
  });
});
