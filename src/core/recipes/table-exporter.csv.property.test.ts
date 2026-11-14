/**
 * Feature: frankendata-recipes, Property 4: CSV export round trip.
 * The exported CSV, parsed by the app's own CSV parser, returns the same
 * values (NULL as empty).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvParser } from "../csv-parser";
import { toCsvText, type ExportCell } from "./table-exporter";

const cell = fc.oneof(
  fc.constant(null),
  fc.string({ unit: "grapheme-ascii", maxLength: 12 }),
  fc.constantFrom('a,b', 'say "hi"', "line1\nline2", "cr\r\nlf", " padded ", "x,\"y\"\n"),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean()
);

describe("Feature: frankendata-recipes, Property 4: CSV round trip", () => {
  it("parses back to the same values", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }).chain((width) =>
          fc.tuple(
            fc.constant(width),
            fc.array(fc.array(cell, { minLength: width, maxLength: width }), { minLength: 1, maxLength: 6 })
          )
        ),
        async ([width, rawRows]) => {
          const columns = Array.from({ length: width }, (_, i) => `col${i}`);
          // Keep every row visible to the parser (it skips blank lines): the
          // first cell always carries a non-blank marker.
          const rows: ExportCell[][] = rawRows.map((r, i) => [`k${i}:${String(r[0] ?? "")}`, ...r.slice(1)]);
          const text = toCsvText(columns, rows);
          const parsed = await new CsvParser().parse(new File([text], "t.csv", { type: "text/csv" }));
          expect(parsed.columnNames).toEqual(columns);
          const expected = rows.map((r) => r.map((c) => (c === null ? "" : String(c))));
          expect(parsed.rows.map((r) => r.map((c) => c ?? ""))).toEqual(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});
