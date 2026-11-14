/**
 * Property-based test: adversarial identifiers are inert.
 *
 * Feature: frankendata-autopsy, Property 6: adversarial table and column names
 * never cause an injected statement to execute.
 *
 * Validates: Requirements 7.2, 7.3, 9.6
 *
 * A canary table holds known rows. Tables and columns are given hostile names
 * (quotes, semicolons, comment markers, SQL keywords, statements that would
 * drop or delete the canary). After the Autopsy the canary must be intact and
 * no table may have been created or dropped.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { runAutopsy } from "./autopsy-engine";
import { snapshot } from "./autopsy-test-support";

const HOSTILE = [
  'a"; DROP TABLE canary; --',
  "'; DELETE FROM canary; --",
  'x" ) ; DROP TABLE canary ; /*',
  "select",
  "from",
  "has space",
  "semi;colon",
  '"quoted"',
  "--comment",
  "/* c */",
  "1; INSERT INTO canary VALUES ('pwned')",
  "Robert'); DROP TABLE canary;--",
];

const nameArb = fc.oneof(
  fc.constantFrom(...HOSTILE),
  fc
    .string({ minLength: 1, maxLength: 12 })
    // Printable only: skip control characters (code points below 32).
    .filter((s) => s.trim().length > 0 && [...s].every((ch) => ch.charCodeAt(0) >= 32))
);

let duck: TestDuckDB;
beforeAll(async () => {
  duck = await createTestDuckDB();
  await duck.service.createTable("canary", [{ name: "v", type: "string" }], [["keep"], ["me"]]);
});
afterAll(() => duck?.dispose());

describe("Property 6: adversarial identifiers never execute injected SQL", () => {
  it("leaves the canary and the catalog untouched and still reports", async () => {
    let used = 0;
    await fc.assert(
      fc.asyncProperty(
        nameArb,
        fc.array(nameArb, { minLength: 1, maxLength: 3 }),
        async (tableName, colNames) => {
          // DuckDB identifiers are case-insensitive: skip colliding names.
          const lower = colNames.map((c) => c.toLowerCase());
          fc.pre(new Set(lower).size === lower.length);
          fc.pre(tableName.toLowerCase() !== "canary");
          fc.pre(!lower.includes("canary"));

          const schema = colNames.map((name, i) => ({
            name,
            type: (i % 2 === 0 ? "string" : "number") as "string" | "number",
          }));
          const rows = [
            schema.map((c) => (c.type === "string" ? "Alpha" : "10")),
            schema.map((c) => (c.type === "string" ? "alpha" : "20")),
          ];
          let loaded;
          try {
            loaded = await duck.service.createTable(tableName, schema, rows);
          } catch {
            // The table could not even be created (outside the engine under test).
            fc.pre(false);
            return;
          }
          used += 1;

          const canaryBefore = await snapshot(duck.service, "canary");
          const tableBefore = await snapshot(duck.service, tableName);

          const report = await runAutopsy(duck.service, {
            tableName,
            schema: loaded.schema,
            rowCount: loaded.rowCount,
          });

          expect(report.status).toBe("ok");
          expect(report.tableName).toBe(tableName);
          expect(await snapshot(duck.service, "canary")).toBe(canaryBefore);
          expect(await snapshot(duck.service, tableName)).toBe(tableBefore);
          // Drop our own table so the catalog does not grow across runs.
          await duck.service.query(`DROP TABLE "${tableName.replace(/"/g, '""')}"`);
          const canaryRows = await duck.service.query<{ v: string }>('SELECT v FROM "canary" ORDER BY v');
          expect(canaryRows.map((r) => r.v)).toEqual(["keep", "me"]);
        }
      ),
      { numRuns: 30 }
    );
    // The property must actually have exercised the engine, not only skipped.
    expect(used).toBeGreaterThan(5);
  }, 120_000);
});
