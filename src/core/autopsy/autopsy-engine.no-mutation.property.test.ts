/**
 * Property-based test: an Autopsy never mutates anything.
 *
 * Feature: frankendata-autopsy, Property 4: running an Autopsy never changes
 * any table's schema, row count, or contents, and creates no table.
 *
 * Validates: Requirements 7.1, 9.4
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { runAutopsy } from "./autopsy-engine";
import { snapshot, tableArb, uniqueName } from "./autopsy-test-support";

let duck: TestDuckDB;
beforeAll(async () => {
  duck = await createTestDuckDB();
});
afterAll(() => duck?.dispose());

describe("Property 4: an Autopsy never changes any table", () => {
  it("leaves schema, contents, and the table catalog identical", async () => {
    await fc.assert(
      fc.asyncProperty(tableArb(), async ({ schema, rows }) => {
        const name = uniqueName("mut");
        const loaded = await duck.service.createTable(name, schema, rows);
        const before = await snapshot(duck.service, name);

        await runAutopsy(duck.service, {
          tableName: name,
          schema: loaded.schema,
          rowCount: loaded.rowCount,
        });

        expect(await snapshot(duck.service, name)).toBe(before);
      }),
      { numRuns: 20 }
    );
  }, 60_000);
});
