/**
 * Feature: frankendata-recipes, Property 6: Safe export file names.
 * For any table name the derived file name matches the safe pattern.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exportFileName } from "./table-exporter";

describe("Feature: frankendata-recipes, Property 6: safe file names", () => {
  it("always yields a safe name with exactly one extension dot", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary" }),
        fc.constantFrom("csv", "xlsx", "parquet"),
        (name, format) => {
          const out = exportFileName(name, format as "csv" | "xlsx" | "parquet");
          expect(out).toMatch(/^[A-Za-z0-9_-]+\.(csv|xlsx|parquet)$/);
        }
      ),
      { numRuns: 300 }
    );
  });
});
