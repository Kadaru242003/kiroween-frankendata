// @vitest-environment node
/**
 * Feature: frankendata-mcp, Property 2: query never executes a statement the
 * validator rejects. A spy on the DuckDB service records every statement.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateSql } from "../../src/core/chat/sql-validator";
import type { DuckDBService } from "../../src/core/types";
import { createNodeDuckDB } from "./node-duckdb";
import { startHarness, type TestHarness } from "./test-support";

const log: string[] = [];
let h: TestHarness;

beforeAll(async () => {
  h = await startHarness({
    createDb: async () => {
      const real = await createNodeDuckDB();
      const service: DuckDBService = {
        ...real.service,
        query: (async (sql: string) => {
          log.push(sql);
          return real.service.query(sql);
        }) as DuckDBService["query"],
      };
      return { service, dispose: real.dispose };
    },
  });
  await h.call("frankendata_load_files", { paths: ["monsters.csv", "experiments.csv"] });
}, 60000);
afterAll(() => h.close());

const hostile = [
  "DROP TABLE monsters", "DELETE FROM monsters", "SELECT 1; DROP TABLE monsters",
  "COPY monsters TO '/tmp/x.csv'", "ATTACH 'x.db'", "PRAGMA database_list", "INSTALL httpfs",
  "SELECT * FROM read_csv('a.csv')", "SELECT * FROM 'a.csv'", "SELECT * FROM main.monsters; --",
  "WITH x AS (SELECT 1) DROP TABLE x", "CREATE TABLE t AS SELECT 1", "SET threads=1", "CALL x()",
  "SELECT * FROM monsters", "SELECT COUNT(*) FROM experiments", "select 1", "", "   ", ";",
];
const fragment = fc.constantFrom("SELECT", "FROM", "monsters", "experiments", "DROP", ";", "--", "'", '"', "*", "(", ")", "UNION", "WITH", "x", "1", " ");
const sqlArb = fc.oneof(
  fc.constantFrom(...hostile),
  fc.string({ maxLength: 40 }),
  fc.array(fragment, { maxLength: 10 }).map((f) => f.join(" "))
);

describe("Feature: frankendata-mcp, Property 2: query respects the validator", () => {
  it("rejected statements never reach DuckDB, accepted ones match the validator", async () => {
    const names = ["monsters", "experiments"];
    await fc.assert(
      fc.asyncProperty(sqlArb, async (sql) => {
        log.length = 0;
        const r = await h.call("frankendata_query", { sql });
        const verdict = validateSql(sql, names);
        if (!verdict.ok) {
          expect(r.isError).toBe(true);
          expect(r.data.error.code).toBe("sql-rejected");
          // The only statements allowed to run are the tool's own catalog
          // lookups (information_schema). Anything else would be derived from
          // the rejected SQL. (A substring check on the SQL text is wrong: a
          // fragment such as "FROM" also appears in those lookups.)
          expect(log.filter((s) => !s.includes("information_schema"))).toEqual([]);
        } else {
          expect(r.data.error?.code).not.toBe("sql-rejected");
          expect(log.some((s) => s.includes(verdict.sql))).toBe(true);
        }
      }),
      { numRuns: 200 }
    );
  }, 120000);
});
