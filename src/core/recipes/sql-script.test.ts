import { describe, expect, it } from "vitest";
import { buildSqlScript, commentSafe, sqlScriptFileName } from "./sql-script";
import { tokenizeScript } from "./sql-script-tokenizer";
import { EXPERIMENTS, MONSTERS, planOf } from "./recipe-test-support";

const now = new Date("2026-11-11T10:00:00.000Z");

describe("buildSqlScript", () => {
  const script = buildSqlScript({ plan: planOf(), tables: [MONSTERS, EXPERIMENTS], now });

  it("has a header, placeholders, and ends with a newline", () => {
    expect(script.startsWith("-- FrankenData SQL script\n-- Generated 2026-11-11")).toBe(true);
    expect(script).toContain("read_csv('/path/to/monsters.csv'");
    expect(script).toContain("read_csv('/path/to/experiments.csv'");
    expect(script.endsWith("\n")).toBe(true);
  });
  it("emits loads, a cleaned copy, and the join, in order", () => {
    const { statements } = tokenizeScript(script);
    // 2 tables x (create + insert), cleaned monsters (create + insert), result.
    expect(statements).toHaveLength(7);
    expect(statements[0]).toMatch(/^CREATE TABLE "monsters"/);
    expect(statements[4]).toMatch(/^CREATE TABLE "stitch_1_clean_monsters"/);
    expect(statements[6]).toMatch(/^CREATE TABLE "stitch_1_result" AS SELECT/);
    expect(statements[6]).toContain('LEFT JOIN "experiments"');
  });
  it("reads the cleaned copy in the join, like the app", () => {
    expect(script).toContain('FROM "stitch_1_clean_monsters" AS "monsters"');
  });
  it("contains no row values and names the xlsx hint", () => {
    const x = buildSqlScript({
      plan: planOf(),
      tables: [{ ...MONSTERS, sourceFileName: "m.xlsx" }, EXPERIMENTS],
      now,
    });
    expect(x).toContain("'/path/to/m.csv'");
    expect(x).toContain("save the sheet as CSV");
  });
  it("names the file from the date", () => {
    expect(sqlScriptFileName(now)).toBe("frankendata-stitch-2026-11-11.sql");
  });
  it("commentSafe reduces text to one safe line", () => {
    expect(commentSafe("a\nb\r\n*/ DROP /* x")).not.toMatch(/[\n\r]|\/\*|\*\//);
    expect(commentSafe("x".repeat(500)).length).toBe(200);
  });
});
