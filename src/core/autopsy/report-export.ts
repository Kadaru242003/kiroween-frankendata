/**
 * Markdown and JSON export for the Autopsy report (Feature 4, task 6).
 *
 * Pure and framework-agnostic: strings in, strings out, no network. The JSON
 * export is the report itself and parses back to an equivalent report. The
 * Markdown export contains the same findings, the health score, and the
 * breakdown, and ESCAPES every table, column, and value string so data cannot
 * change the document structure (no headings, table rows, links, or HTML from
 * data; Requirement 6.3, 6.5).
 */

import type { AutopsyReport, ColumnFinding } from "./types.js";

/** Escape text so it cannot alter Markdown structure or inject HTML. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/[`*_{}\[\]()#+\-!|~>]/g, (ch) => `\\${ch}`)
    .replace(/</g, "&lt;")
    .replace(/&(?!lt;)/g, "&amp;")
    .replace(/[\r\n]+/g, " ");
}

/** The report as pretty-printed JSON. Parses back to an equivalent report. */
export function toJson(report: AutopsyReport): string {
  return JSON.stringify(report, null, 2);
}

function fmt(v: number | string | undefined): string {
  if (v === undefined) return "";
  return typeof v === "number"
    ? Number.isInteger(v)
      ? String(v)
      : v.toFixed(2)
    : escapeMarkdown(v);
}

function list(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.map(escapeMarkdown).join(", ");
}

function columnRow(c: ColumnFinding): string {
  return (
    `| ${escapeMarkdown(c.name)} | ${c.type} | ${c.status.toUpperCase()} | ` +
    `${c.nullPct.toFixed(1)}% | ${c.distinct} | ${fmt(c.min)} | ${fmt(c.max)} | ` +
    `${fmt(c.mean)} | ${fmt(c.median)} |`
  );
}

/** The report as a Markdown document. */
export function toMarkdown(report: AutopsyReport): string {
  const out: string[] = [];
  out.push(`# Autopsy case file: ${escapeMarkdown(report.tableName)}`, "");

  if (report.status !== "ok") {
    out.push(`Status: ${report.status}`, "");
    if (report.message) out.push(escapeMarkdown(report.message), "");
    return out.join("\n");
  }

  out.push(`Health score: **${report.health.score} / 100**`, "");
  out.push(`Rows: ${report.rows}. Columns: ${report.columnCount}.`, "");

  out.push("## Score breakdown", "");
  if (report.health.breakdown.length === 0) {
    out.push("No deductions.", "");
  } else {
    for (const d of report.health.breakdown) {
      out.push(`- -${d.points}: ${escapeMarkdown(d.reason)}`);
    }
    out.push("");
  }

  out.push("## Table findings", "");
  out.push(`- Exact duplicate rows: ${report.duplicateRows}`);
  out.push(`- Candidate key columns: ${list(report.candidateKeys)}`);
  out.push(`- All-null columns: ${list(report.allNullColumns)}`);
  out.push(`- Constant columns: ${list(report.constantColumns)}`, "");

  out.push("## Columns", "");
  out.push("| Column | Type | Status | Nulls | Distinct | Min | Max | Mean | Median |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of report.columns) out.push(columnRow(c));
  out.push("");

  for (const c of report.columns) {
    const lines: string[] = [];
    if (c.topValues && c.topValues.length > 0) {
      lines.push(
        `- Top values: ${c.topValues
          .map((t) => `${escapeMarkdown(t.value)} (${t.count})`)
          .join(", ")}`
      );
    }
    if ((c.whitespaceRows ?? 0) > 0) lines.push(`- Rows with stray whitespace: ${c.whitespaceRows}`);
    if ((c.caseVariantGroups ?? 0) > 0) lines.push(`- Case variant groups: ${c.caseVariantGroups}`);
    if ((c.categoryVariants ?? 0) > 0) lines.push(`- Category variants: ${c.categoryVariants}`);
    if (c.outliers && c.outliers.count > 0) {
      lines.push(
        `- Outliers: ${c.outliers.count} (examples: ${c.outliers.examples.join(", ")})`
      );
    }
    for (const reason of c.statusReasons) lines.push(`- Note: ${escapeMarkdown(reason)}`);
    if (lines.length > 0) {
      out.push(`### ${escapeMarkdown(c.name)}`, "", ...lines, "");
    }
  }

  if (report.fixes.length > 0) {
    out.push("## Available fixes", "");
    for (const f of report.fixes) out.push(`- ${escapeMarkdown(f.label)}`);
    out.push("");
  }
  return out.join("\n");
}
