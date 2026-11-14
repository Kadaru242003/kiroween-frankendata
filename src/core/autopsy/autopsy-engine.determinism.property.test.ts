/**
 * Property-based test: Autopsy determinism.
 *
 * Feature: frankendata-autopsy, Property 3: running the AutopsyEngine twice on
 * the same table yields identical reports.
 *
 * Validates: Requirement 9.3
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTestDuckDB, type TestDuckDB } from "./duckdb-test-harness";
import { runAutopsy } from "./autopsy-engine";
import { tableArb, uniqueName } from "./autopsy-test-support";

let duck: TestDuckDB;
beforeAll(async () => {
  duck = await createTestDuckDB();
});
afterAll(() => duck?.dispose());

describe("Property 3: the same table yields identical reports", () => {
  it("holds for arbitrary small tables", async () => {
    await fc.assert(
      fc.asyncProperty(tableArb(), async ({ schema, rows }) => {
        const name = uniqueName("det");
        const loaded = await duck.service.createTable(name, schema, rows);
        const target = { tableName: name, schema: loaded.schema, rowCount: loaded.rowCount };
        const first = await runAutopsy(duck.service, target);
        const second = await runAutopsy(duck.service, target);
        expect(second).toEqual(first);
        expect(first.status).toBe("ok");
        expect(first.complete).toBe(true);
      }),
      { numRuns: 20 }
    );
  }, 60_000);
});
