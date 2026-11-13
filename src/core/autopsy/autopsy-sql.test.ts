/**
 * Unit tests for the Autopsy SQL builders (Feature 4, task 1).
 *
 * Requirements 2.10, 7.1, 7.2, 7.3: read-only SELECTs, quoted identifiers,
 * generated aliases, and finite-number-only interpolation.
 */

import { describe, expect, it } from "vitest";
import {
  buildDuplicatesSql,
  buildOutlierCountSql,
  buildOutlierExamplesSql,
  buildStageASql,
  buildStringVariantsSql,
  buildTopValuesSql,
  numLit,
} from "./autopsy-sql";
import type { ColumnSchema } from "../types";

const HOSTILE = 'a"; DROP TABLE t; --';

describe("numLit", () => {
  it("formats finite numbers", () => {
    expect(numLit(3)).toBe("3");
    expect(numLit(-2.5)).toBe("-2.5");
  });

  it("rejects NaN and infinities so they can never become SQL text", () => {
    expect(() => numLit(Number.NaN)).toThrow(RangeError);
    expect(() => numLit(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => numLit(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("buildStageASql", () => {
  const schema: ColumnSchema[] = [
    { name: "name", type: "string" },
    { name: "power", type: "number" },
    { name: "seen", type: "date" },
    { name: "ok", type: "boolean" },
  ];

  it("is one read-only SELECT with generated aliases", () => {
    const sql = buildStageASql("monsters", schema);
    expect(sql.startsWith("SELECT COUNT(*) AS n")).toBe(true);
    expect(sql).toContain('FROM "monsters"');
    expect(sql).toContain("COUNT(\"name\") AS nn0");
    expect(sql).toContain("COUNT(DISTINCT \"power\") AS d1");
    // Numeric statistics only for the number column.
    expect(sql).toContain("quantile_cont(\"power\", 0.25) AS DOUBLE) AS q1_1");
    expect(sql).not.toContain("q1_0");
    // Date statistics use epoch seconds for mean and median.
    expect(sql).toContain("epoch(\"seen\")");
    // Boolean gets only the counts.
    expect(sql).not.toContain("mn3");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/);
  });

  it("selects just the row count for a table with no columns", () => {
    expect(buildStageASql("t", [])).toBe('SELECT COUNT(*) AS n FROM "t"');
  });

  it("quotes hostile identifiers and never uses them as aliases", () => {
    const sql = buildStageASql(HOSTILE, [{ name: HOSTILE, type: "number" }]);
    // The embedded double quote is doubled, so the name stays one identifier.
    expect(sql).toContain('"a""; DROP TABLE t; --"');
    // Every alias is a generated token (n, nn0, d0, mn0, ...), never the name.
    const aliases = [...sql.matchAll(/ AS ([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(alias).toMatch(/^(DOUBLE|n|(nn|d|mn|mx|av|md|q1_|q3_)\d+)$/);
    }
  });
});

describe("other builders", () => {
  it("duplicates compares COUNT(*) with DISTINCT whole rows", () => {
    expect(buildDuplicatesSql("t")).toBe(
      'SELECT COUNT(*) - (SELECT COUNT(*) FROM (SELECT DISTINCT * FROM "t")) AS dups FROM "t"'
    );
  });

  it("top values orders by count desc then value asc with a limit", () => {
    const sql = buildTopValuesSql("t", "c", 5);
    expect(sql).toContain("ORDER BY c DESC, v ASC LIMIT 5");
    expect(sql).toContain('WHERE "c" IS NOT NULL');
  });

  it("clamps a bad limit instead of injecting it", () => {
    expect(buildTopValuesSql("t", "c", -3)).toContain("LIMIT 0");
    expect(buildTopValuesSql("t", "c", 2.9)).toContain("LIMIT 2");
  });

  it("string variants selects ws and cg", () => {
    const sql = buildStringVariantsSql("t", "c");
    expect(sql).toContain("AS ws");
    expect(sql).toContain("AS cg");
    expect(sql).toContain("LOWER(");
  });

  it("outlier builders embed only numeric literals", () => {
    const count = buildOutlierCountSql("t", "c", -1.5, 10);
    expect(count).toContain('"c" < -1.5 OR "c" > 10');
    const ex = buildOutlierExamplesSql("t", "c", -1.5, 10, 4, 5);
    expect(ex).toContain("ORDER BY ABS(\"c\" - 4) DESC");
    expect(ex).toContain("LIMIT 5");
  });

  it("outlier builders refuse non-finite fences", () => {
    expect(() => buildOutlierCountSql("t", "c", Number.NaN, 1)).toThrow();
    expect(() => buildOutlierExamplesSql("t", "c", 0, 1, Number.NaN, 5)).toThrow();
  });
});
