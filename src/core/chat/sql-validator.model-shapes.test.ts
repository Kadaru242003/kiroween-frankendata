/**
 * The SQL a typical model writes for "invoiced revenue by region in
 * stitch_1_result" (and close cousins): quoted and unquoted identifiers, ORDER BY
 * an alias, ROUND, CAST, COALESCE, ILIKE, CTEs, window and date functions. Every
 * valid read-only shape must pass the validator. The shapes that are rejected on
 * purpose, and the bypass attempts, must still fail closed.
 */
import { describe, expect, it } from "vitest";
import { validateSql } from "./sql-validator";

const NAMES = ["stitch_1_result", "crm_customers", "billing_invoices", "stitch_1_clean_crm_customers"];

const ACCEPT: Record<string, string> = {
  unquoted: `SELECT region, SUM(amount) AS invoiced_revenue FROM stitch_1_result GROUP BY region ORDER BY invoiced_revenue DESC`,
  quoted: `SELECT "region", SUM("amount") AS "invoiced_revenue" FROM "stitch_1_result" GROUP BY "region" ORDER BY "invoiced_revenue" DESC`,
  "main-qualified": `SELECT r.region, SUM(r.amount) AS total FROM main.stitch_1_result AS r GROUP BY r.region ORDER BY total DESC`,
  "quoted main-qualified": `SELECT "region", SUM("amount") FROM "main"."stitch_1_result" GROUP BY 1 ORDER BY 2 DESC`,
  ROUND: `SELECT region, ROUND(SUM(amount), 2) AS revenue FROM stitch_1_result GROUP BY region ORDER BY revenue DESC`,
  CAST: `SELECT region, SUM(CAST(amount AS DOUBLE)) AS revenue FROM stitch_1_result GROUP BY region ORDER BY revenue DESC`,
  "TRY_CAST decimal": `SELECT region, SUM(TRY_CAST(amount AS DECIMAL(18,2))) AS revenue FROM stitch_1_result GROUP BY region ORDER BY 2 DESC`,
  "double-colon cast": `SELECT region, SUM(amount)::DOUBLE AS r FROM stitch_1_result GROUP BY region`,
  COALESCE: `SELECT COALESCE(region, 'Unknown') AS region, SUM(COALESCE(amount, 0)) AS revenue FROM stitch_1_result GROUP BY COALESCE(region, 'Unknown') ORDER BY revenue DESC`,
  ILIKE: `SELECT region, SUM(amount) AS revenue FROM stitch_1_result WHERE status ILIKE 'paid' GROUP BY region ORDER BY revenue DESC`,
  "ILIKE overdue": `SELECT region, COUNT(*) AS overdue FROM stitch_1_result WHERE status ILIKE '%overdue%' GROUP BY region ORDER BY overdue DESC LIMIT 1`,
  CTE: `WITH by_region AS (SELECT region, SUM(amount) AS revenue FROM stitch_1_result GROUP BY region) SELECT * FROM by_region ORDER BY revenue DESC`,
  "two CTEs": `WITH a AS (SELECT region, amount FROM stitch_1_result), b AS (SELECT region, SUM(amount) AS s FROM a GROUP BY region) SELECT region, s FROM b ORDER BY s DESC LIMIT 10`,
  subquery: `SELECT region, revenue FROM (SELECT region, SUM(amount) AS revenue FROM stitch_1_result GROUP BY region) t ORDER BY revenue DESC`,
  "SELECT DISTINCT subquery": `SELECT region, SUM(amount) FROM (SELECT DISTINCT * FROM stitch_1_result) AS d GROUP BY region`,
  "window function": `SELECT region, SUM(amount) AS revenue, RANK() OVER (ORDER BY SUM(amount) DESC) AS rnk FROM stitch_1_result GROUP BY region`,
  FILTER: `SELECT region, SUM(amount) FILTER (WHERE status = 'Paid') AS paid, SUM(amount) FILTER (WHERE status = 'Overdue') AS overdue FROM stitch_1_result GROUP BY region`,
  "CASE WHEN": `SELECT region, SUM(CASE WHEN LOWER(status) = 'overdue' THEN amount ELSE 0 END) AS overdue_amount FROM stitch_1_result GROUP BY region ORDER BY overdue_amount DESC`,
  date_trunc: `SELECT date_trunc('month', invoice_date) AS month, SUM(amount) AS total FROM stitch_1_result GROUP BY 1 ORDER BY 1`,
  strftime: `SELECT strftime(invoice_date, '%Y-%m') AS month, SUM(amount) AS total FROM stitch_1_result GROUP BY 1 ORDER BY 1`,
  EXTRACT: `SELECT EXTRACT(month FROM invoice_date) AS m, SUM(amount) FROM stitch_1_result GROUP BY m ORDER BY m`,
  "trailing semicolon": `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region;`,
  "trailing semicolon and newline": `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region;\n`,
  "line comment": `-- revenue by region\nSELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region ORDER BY r DESC`,
  "block comment": `/* revenue */ SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region`,
  LIMIT: `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region ORDER BY r DESC LIMIT 20`,
  "LIMIT OFFSET": `SELECT * FROM stitch_1_result ORDER BY amount DESC LIMIT 10 OFFSET 5`,
  "join with lower()": `SELECT c.region, SUM(b.amount) FROM crm_customers c JOIN billing_invoices b ON lower(c.email) = lower(b.email) GROUP BY c.region`,
  "LEFT JOIN USING": `SELECT region, SUM(amount) FROM crm_customers LEFT JOIN billing_invoices USING (email) GROUP BY region`,
  "UNION ALL": `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region UNION ALL SELECT 'Total', SUM(amount) FROM stitch_1_result`,
  "upper-case names": `SELECT REGION, SUM(AMOUNT) AS REVENUE FROM STITCH_1_RESULT GROUP BY REGION ORDER BY REVENUE DESC`,
  "table-qualified columns": `SELECT stitch_1_result.region, SUM(stitch_1_result.amount) FROM stitch_1_result GROUP BY stitch_1_result.region`,
  "alias with spaces": `SELECT region, SUM(amount) AS "Total Revenue (USD)" FROM stitch_1_result GROUP BY region ORDER BY "Total Revenue (USD)" DESC`,
  "';' inside a string": `SELECT region FROM stitch_1_result WHERE client_name = 'A; B' GROUP BY region`,
  "keyword inside a string": `SELECT region FROM stitch_1_result WHERE client_name = 'Drop Table Inc' GROUP BY region`,
  "escaped quote in a string": `SELECT region FROM stitch_1_result WHERE client_name = 'O''Brien Ltd' GROUP BY region`,
  "quoted keyword aliases": `SELECT region, COUNT(*) AS "set", MAX(amount) AS "load", SUM(amount) AS "export" FROM stitch_1_result GROUP BY region`,
  "GROUP BY ALL": `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY ALL ORDER BY r DESC`,
  "ORDER BY ALL": `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region ORDER BY ALL`,
  "positional GROUP BY": `SELECT region, SUM(amount) FROM stitch_1_result GROUP BY 1 ORDER BY 2 DESC`,
  "NULLS LAST": `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region ORDER BY r DESC NULLS LAST`,
  HAVING: `SELECT region, SUM(amount) AS r FROM stitch_1_result GROUP BY region HAVING SUM(amount) > 1000`,
  "COUNT DISTINCT": `SELECT region, COUNT(DISTINCT email) FROM stitch_1_result GROUP BY region`,
  "regexp_replace": `SELECT regexp_replace(region, '\\s+', ' ', 'g') AS region, SUM(amount) FROM stitch_1_result GROUP BY 1`,
  VALUES: `SELECT * FROM (VALUES (1), (2)) AS t(x)`,
  "USING SAMPLE": `SELECT region, SUM(amount) FROM stitch_1_result USING SAMPLE 50 PERCENT GROUP BY region`,
  "clean copy": `SELECT "Region", COUNT(*) FROM "stitch_1_clean_crm_customers" GROUP BY "Region"`,
};

const REJECT: Record<string, string> = {
  "unquoted COPY as an alias (a whole-word forbidden keyword)": `SELECT region AS copy FROM stitch_1_result`,
  "catalog-qualified table (only main. is allowed)": `SELECT * FROM memory.main.stitch_1_result LIMIT 5`,
  information_schema: `SELECT column_name FROM information_schema.columns WHERE table_name = 'stitch_1_result'`,
  SUMMARIZE: `SUMMARIZE stitch_1_result`,
  "a table that is not loaded": `SELECT * FROM secret_table`,
  DROP: `DROP TABLE stitch_1_result`,
  "second statement": `SELECT 1; DROP TABLE stitch_1_result`,
  read_csv: `SELECT * FROM read_csv('/etc/passwd')`,
  "read_csv after a subquery": `SELECT * FROM (SELECT 1) q, read_csv('/etc/passwd')`,
  "comment-split function": `SELECT * FROM (SELECT 1) q, read_/**/csv('x')`,
  "hidden unknown table after a subquery": `SELECT * FROM (SELECT 1) q, secret_table`,
  COPY: `COPY stitch_1_result TO 'out.csv'`,
  ATTACH: `ATTACH 'x.db'`,
  PRAGMA: `PRAGMA table_info('stitch_1_result')`,
  INSERT: `INSERT INTO stitch_1_result SELECT * FROM stitch_1_result`,
  "NUL byte": `SELECT 1\u0000`,
  "string path in a table position": `SELECT * FROM 'file.csv'`,
};

describe("valid read-only SQL a model writes is accepted", () => {
  for (const [name, sql] of Object.entries(ACCEPT)) {
    it(name, () => {
      const result = validateSql(sql, NAMES);
      expect(result.ok, result.ok ? "" : `rejected: ${result.reason}`).toBe(true);
    });
  }
});

describe("everything that must be refused still fails closed", () => {
  for (const [name, sql] of Object.entries(REJECT)) {
    it(name, () => {
      expect(validateSql(sql, NAMES).ok).toBe(false);
    });
  }
});
