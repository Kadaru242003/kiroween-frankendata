/**
 * Pure-builder unit tests for the StitchApplier cleaned-copy SQL (Feature 2,
 * task 8.1). These assert the generated DDL/DML shape and the escaping
 * invariant (Property 13) WITHOUT a database: every identifier goes through
 * {@link quoteIdent}, every literal through {@link quoteString}, and adversarial
 * names/values never break out of their quoting.
 *
 * The behavioral "it actually cleans correctly over real data / originals
 * untouched / types preserved" assertions live in the DuckDB-backed companion
 * `stitch-applier.duckdb.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { ColumnSchema } from "../types";
import {
  buildCleanedCopySql,
  cleanedCopyTableName,
  groupApprovedForTable,
  IS_OUTLIER_COLUMN,
  type ApprovedCleaning,
} from "./stitch-applier";
import type { CleaningProposal } from "./types";

const EMPTY: ApprovedCleaning = {
  columnProposals: [],
  outlierColumns: [],
  dedupe: false,
};

describe("cleanedCopyTableName", () => {
  it("formats stitch_<n>_clean_<name>", () => {
    expect(cleanedCopyTableName(0, "monsters")).toBe("stitch_0_clean_monsters");
    expect(cleanedCopyTableName(3, "experiments")).toBe(
      "stitch_3_clean_experiments"
    );
  });

  it("rejects non-integer / negative counters", () => {
    expect(() => cleanedCopyTableName(-1, "t")).toThrow(RangeError);
    expect(() => cleanedCopyTableName(1.5, "t")).toThrow(RangeError);
  });

  it("leaves the raw source name in the identifier (escaping happens in SQL)", () => {
    // The name is embedded verbatim; quoteIdent protects it when it reaches SQL.
    expect(cleanedCopyTableName(2, 'weird"name')).toBe(
      'stitch_2_clean_weird"name'
    );
  });
});

describe("buildCleanedCopySql — typed DDL & column preservation", () => {
  const schema: ColumnSchema[] = [
    { name: "name", type: "string" },
    { name: "weight", type: "number" },
    { name: "sedated", type: "boolean" },
    { name: "captured", type: "date" },
  ];

  it("creates a typed copy preserving every source column's type", () => {
    const { createSql, columns, tableName } = buildCleanedCopySql(
      0,
      "monsters",
      schema,
      EMPTY
    );
    expect(tableName).toBe("stitch_0_clean_monsters");
    expect(createSql).toBe(
      'CREATE TABLE "stitch_0_clean_monsters" ' +
        '("name" VARCHAR, "weight" DOUBLE, "sedated" BOOLEAN, "captured" DATE)'
    );
    expect(columns).toEqual(schema);
  });

  it("selects every column verbatim when no cleaning targets it", () => {
    const { insertSql } = buildCleanedCopySql(0, "monsters", schema, EMPTY);
    expect(insertSql).toBe(
      'INSERT INTO "stitch_0_clean_monsters" ' +
        'SELECT "name", "weight", "sedated", "captured" FROM "monsters"'
    );
  });

  it("appends an is_outlier BOOLEAN column and a quartile CTE when outliers approved", () => {
    const approved: ApprovedCleaning = {
      ...EMPTY,
      outlierColumns: [{ name: "weight", type: "number" }],
    };
    const { createSql, insertSql, columns } = buildCleanedCopySql(
      1,
      "monsters",
      schema,
      approved
    );
    expect(createSql).toContain('"is_outlier" BOOLEAN');
    expect(columns.at(-1)).toEqual({ name: IS_OUTLIER_COLUMN, type: "boolean" });
    // Quartiles over the FULL column via quantile_cont; flag compares fences.
    expect(insertSql).toContain("WITH q AS (SELECT quantile_cont");
    expect(insertSql).toContain('quantile_cont("weight", 0.25)');
    expect(insertSql).toContain('quantile_cont("weight", 0.75)');
    expect(insertSql).toContain('FROM "monsters", q');
  });

  it("wraps with keep-first row_number dedupe when duplicate-rows approved", () => {
    const approved: ApprovedCleaning = { ...EMPTY, dedupe: true };
    const { insertSql } = buildCleanedCopySql(0, "monsters", schema, approved);
    expect(insertSql).toContain("row_number() OVER (PARTITION BY");
    expect(insertSql).toContain("ORDER BY rowid");
    expect(insertSql).toMatch(/WHERE __rn = 1\s*$/);
  });
});

describe("buildCleanedCopySql — transform expressions", () => {
  const schema: ColumnSchema[] = [{ name: "species", type: "string" }];

  it("emits trim + collapse for a whitespace proposal (never changes case)", () => {
    const whitespace: CleaningProposal = {
      id: "clean:whitespace:t.species",
      target: { tableName: "t", columnName: "species" },
      kind: "whitespace-case",
      before: " a  b ",
      after: "a b",
      reason: "ws",
    };
    const approved: ApprovedCleaning = {
      ...EMPTY,
      columnProposals: [whitespace],
    };
    const { insertSql } = buildCleanedCopySql(0, "t", schema, approved);
    expect(insertSql).toContain(
      `regexp_replace(trim("species"), '\\s+', ' ', 'g')`
    );
  });

  it("emits a CASE map for differing-casing (case) proposals", () => {
    const caseProposal: CleaningProposal = {
      id: "clean:case:t.species",
      target: { tableName: "t", columnName: "species" },
      kind: "whitespace-case",
      before: "swamp wraith",
      after: "Swamp Wraith",
      reason: "case",
      variantMap: { "swamp wraith": "Swamp Wraith" },
    };
    const approved: ApprovedCleaning = {
      ...EMPTY,
      columnProposals: [caseProposal],
    };
    const { insertSql } = buildCleanedCopySql(0, "t", schema, approved);
    expect(insertSql).toContain(
      `CASE "species" WHEN 'swamp wraith' THEN 'Swamp Wraith' ELSE "species" END`
    );
  });

  it("emits a CASE map to the canonical literal for category-standardize", () => {
    const category: CleaningProposal = {
      id: "clean:category:t.species",
      target: { tableName: "t", columnName: "species" },
      kind: "category-standardize",
      before: "swamp-wraith",
      after: "Swamp Wraith",
      reason: "cat",
      canonical: "Swamp Wraith",
      variantMap: {
        "swamp-wraith": "Swamp Wraith",
        "swamp wraith": "Swamp Wraith",
      },
    };
    const approved: ApprovedCleaning = {
      ...EMPTY,
      columnProposals: [category],
    };
    const { insertSql } = buildCleanedCopySql(0, "t", schema, approved);
    // Variants emitted in a fixed (lexicographic) order.
    expect(insertSql).toContain(
      `CASE "species" WHEN 'swamp wraith' THEN 'Swamp Wraith' ` +
        `WHEN 'swamp-wraith' THEN 'Swamp Wraith' ELSE "species" END`
    );
  });

  it("nests whitespace → case for a column targeted by both", () => {
    const whitespace: CleaningProposal = {
      id: "ws",
      target: { tableName: "t", columnName: "species" },
      kind: "whitespace-case",
      before: "x",
      after: "x",
      reason: "ws",
    };
    const caseProposal: CleaningProposal = {
      id: "case",
      target: { tableName: "t", columnName: "species" },
      kind: "whitespace-case",
      before: "a",
      after: "A",
      reason: "case",
      variantMap: { a: "A" },
    };
    const approved: ApprovedCleaning = {
      ...EMPTY,
      columnProposals: [whitespace, caseProposal],
    };
    const { insertSql } = buildCleanedCopySql(0, "t", schema, approved);
    // whitespace innermost, case wraps it.
    expect(insertSql).toContain(
      `CASE regexp_replace(trim("species"), '\\s+', ' ', 'g') WHEN 'a' THEN 'A' ` +
        `ELSE regexp_replace(trim("species"), '\\s+', ' ', 'g') END`
    );
  });
});

describe("escaping invariant (Property 13): adversarial names/values", () => {
  it("doubles embedded quotes in table and column identifiers", () => {
    const schema: ColumnSchema[] = [{ name: 'na"me', type: "string" }];
    const { createSql, insertSql } = buildCleanedCopySql(
      0,
      'tab"le',
      schema,
      EMPTY
    );
    // Identifier quoting doubles the embedded ".
    expect(createSql).toContain('"stitch_0_clean_tab""le"');
    expect(createSql).toContain('"na""me" VARCHAR');
    expect(insertSql).toContain('"na""me"');
    expect(insertSql).toContain('FROM "tab""le"');
  });

  it("doubles embedded single quotes in CASE variant literals", () => {
    const schema: ColumnSchema[] = [{ name: "who", type: "string" }];
    const category: CleaningProposal = {
      id: "c",
      target: { tableName: "t", columnName: "who" },
      kind: "category-standardize",
      before: "o'brien",
      after: "O'Brien",
      reason: "cat",
      canonical: "O'Brien",
      variantMap: { "o'brien": "O'Brien" },
    };
    const approved: ApprovedCleaning = {
      ...EMPTY,
      columnProposals: [category],
    };
    const { insertSql } = buildCleanedCopySql(0, "t", schema, approved);
    expect(insertSql).toContain(`WHEN 'o''brien' THEN 'O''Brien'`);
  });

  it("keeps a SQL-injection-style value inside its literal quoting", () => {
    const schema: ColumnSchema[] = [{ name: "v", type: "string" }];
    const evil = "x'); DROP TABLE monsters;--";
    const category: CleaningProposal = {
      id: "c",
      target: { tableName: "t", columnName: "v" },
      kind: "category-standardize",
      before: evil,
      after: "safe",
      reason: "cat",
      canonical: "safe",
      variantMap: { [evil]: "safe" },
    };
    const { insertSql } = buildCleanedCopySql(0, "t", schema, {
      ...EMPTY,
      columnProposals: [category],
    });
    // The payload appears only as a doubled-quote literal, never as live SQL:
    // the embedded single quote is doubled so the literal cannot be closed
    // early. Every single quote in the generated SQL must be part of a balanced
    // pair (doubled escape or a literal delimiter), i.e. an even count.
    expect(insertSql).toContain(`'x''); DROP TABLE monsters;--'`);
    const singleQuotes = (insertSql.match(/'/g) ?? []).length;
    expect(singleQuotes % 2).toBe(0);
  });
});

describe("groupApprovedForTable", () => {
  const schema: ColumnSchema[] = [
    { name: "label", type: "string" },
    { name: "weight", type: "number" },
  ];

  it("splits proposals into per-column, outlier, and dedupe buckets", () => {
    const proposals: CleaningProposal[] = [
      {
        id: "ws",
        target: { tableName: "t", columnName: "label" },
        kind: "whitespace-case",
        before: " a ",
        after: "a",
        reason: "ws",
      },
      {
        id: "out",
        target: { tableName: "t", columnName: "weight" },
        kind: "outliers",
        before: {},
        after: {},
        reason: "out",
      },
      {
        id: "dup",
        target: { tableName: "t" },
        kind: "duplicate-rows",
        before: {},
        after: {},
        reason: "dup",
      },
    ];
    const grouped = groupApprovedForTable(schema, proposals);
    expect(grouped.columnProposals).toHaveLength(1);
    expect(grouped.outlierColumns).toEqual([{ name: "weight", type: "number" }]);
    expect(grouped.dedupe).toBe(true);
  });

  it("ignores outlier proposals targeting non-number columns", () => {
    const proposals: CleaningProposal[] = [
      {
        id: "out",
        target: { tableName: "t", columnName: "label" },
        kind: "outliers",
        before: {},
        after: {},
        reason: "out",
      },
    ];
    const grouped = groupApprovedForTable(schema, proposals);
    expect(grouped.outlierColumns).toEqual([]);
  });
});
