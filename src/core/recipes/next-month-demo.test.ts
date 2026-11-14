import { describe, expect, it } from "vitest";
import { CsvParser } from "../csv-parser";
import { demoDataLoader } from "../demo-data-loader";
import { loadNextMonthFiles } from "./next-month-demo";

async function parse(f: File) {
  return new CsvParser().parse(f);
}

describe("next month demo", () => {
  it("loads two files with the mismatched demo's names and headers", async () => {
    const next = await loadNextMonthFiles();
    const prev = await demoDataLoader.loadMismatched();
    expect(next.map((f) => f.name)).toEqual(prev.map((f) => f.name));
    for (let i = 0; i < next.length; i++) {
      expect((await parse(next[i])).columnNames).toEqual((await parse(prev[i])).columnNames);
    }
  });
  it("has different rows, new duplicates, and shared creature names", async () => {
    const [m2, e2] = (await loadNextMonthFiles()).map(parse);
    const [m1] = (await demoDataLoader.loadMismatched()).map(parse);
    const monsters2 = await m2;
    const experiments2 = await e2;
    const monsters1 = await m1;
    const key = (r: (string | null)[]) => JSON.stringify(r);
    const prevKeys = new Set(monsters1.rows.map(key));
    expect(monsters2.rows.filter((r) => prevKeys.has(key(r)))).toHaveLength(0);
    expect(new Set(monsters2.rows.map(key)).size).toBeLessThan(monsters2.rows.length);
    expect(new Set(experiments2.rows.map(key)).size).toBeLessThan(experiments2.rows.length);
    const names = new Set(monsters2.rows.map((r) => r[0]));
    const shared = experiments2.rows.filter((r) => names.has(r[0]));
    expect(shared.length).toBe(experiments2.rows.length);
  });
});
