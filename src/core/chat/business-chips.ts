/**
 * Starter questions for the business demo tables (`crm_customers` and
 * `billing_invoices`). Rule-built SQL, no AI. Detected by table and column
 * names; any other table gets nothing from here. Every identifier is quoted.
 */
import { quoteIdent } from "../stitching/sql-escape.js";
import type { StarterChip } from "./starter-questions.js";
import type { QueryableTable } from "./types.js";

function findColumn(table: QueryableTable, name: string): string | undefined {
  return table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.name;
}

export function generateBusinessChips(tables: readonly QueryableTable[]): StarterChip[] {
  const chips: StarterChip[] = [];
  // After stitching: invoiced revenue by the CLEANED CRM region (Region_1 in
  // the stitched result). Listed first; the raw-table chip below stays.
  const stitched = tables.find(
    (t) =>
      /^stitch_\d+_result$/.test(t.tableName) &&
      findColumn(t, "Region_1") !== undefined &&
      findColumn(t, "amount") !== undefined
  );
  if (stitched) {
    const region = findColumn(stitched, "Region_1")!;
    const amount = findColumn(stitched, "amount")!;
    chips.push({
      tableName: stitched.tableName,
      question: `What is the invoiced revenue by region in ${stitched.tableName}?`,
      sql:
        `SELECT ${quoteIdent(region)}, SUM(${quoteIdent(amount)}) AS invoiced_revenue ` +
        `FROM ${quoteIdent(stitched.tableName)} GROUP BY ${quoteIdent(region)} ` +
        `ORDER BY invoiced_revenue DESC`,
      kind: "numeric",
      chart: { type: "bar", x: region, y: "invoiced_revenue" },
    });
  }
  const crm = tables.find((t) => t.tableName === "crm_customers");
  if (crm) {
    const region = findColumn(crm, "Region");
    const revenue = findColumn(crm, "Monthly_Revenue");
    if (region && revenue) {
      chips.push({
        tableName: crm.tableName,
        question: "What is the monthly revenue by region in crm_customers?",
        // DISTINCT drops exact duplicate customer rows before summing.
        sql:
          `SELECT ${quoteIdent(region)}, SUM(${quoteIdent(revenue)}) AS monthly_revenue ` +
          `FROM (SELECT DISTINCT * FROM ${quoteIdent(crm.tableName)}) AS c ` +
          `GROUP BY ${quoteIdent(region)} ORDER BY monthly_revenue DESC`,
        kind: "numeric",
        chart: { type: "bar", x: region, y: "monthly_revenue" },
      });
    }
  }
  const billing = tables.find((t) => t.tableName === "billing_invoices");
  if (billing) {
    const date = findColumn(billing, "invoice_date");
    const amount = findColumn(billing, "amount");
    if (date && amount) {
      chips.push({
        tableName: billing.tableName,
        question: "What is the invoiced amount by month?",
        sql:
          `SELECT CAST(date_trunc('month', ${quoteIdent(date)}) AS DATE) AS month, ` +
          `SUM(${quoteIdent(amount)}) AS total_amount ` +
          `FROM ${quoteIdent(billing.tableName)} GROUP BY 1 ORDER BY 1`,
        kind: "numeric",
        chart: { type: "line", x: "month", y: "total_amount" },
      });
    }
  }
  return chips;
}
