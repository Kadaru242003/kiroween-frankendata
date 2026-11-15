import { describe, expect, it } from "vitest";
import {
  CRACKLE_MIN_GAP_MS,
  JAR_LEVEL_MAX,
  JAR_LEVEL_MIN,
  JAR_NAME_MAX_CHARS,
  SHELF_MAX_JARS,
  buildJars,
  jarAriaLabel,
  liquidLevel,
  nextCrackleDelayMs,
  rowsText,
  truncateName,
} from "./shelf-model";

const t = (name: string, rows: number) => ({ tableName: name, rowCount: rows });
const many = (n: number) => Array.from({ length: n }, (_, i) => t(`table_${i + 1}`, 10 * (i + 1)));

describe("liquidLevel", () => {
  it("is clamped to the minimum and maximum, whatever the row count", () => {
    for (const rows of [0, 1, -5, NaN, -Infinity]) expect(liquidLevel(rows)).toBe(JAR_LEVEL_MIN);
    for (const rows of [1e6, 1e9, Infinity]) expect(liquidLevel(rows)).toBe(JAR_LEVEL_MAX);
  });
  it("rises gently and never falls as rows grow", () => {
    let last = 0;
    for (const rows of [1, 2, 10, 48, 100, 1000, 10000, 100000]) {
      const level = liquidLevel(rows);
      expect(level).toBeGreaterThanOrEqual(last);
      expect(level).toBeGreaterThanOrEqual(JAR_LEVEL_MIN);
      expect(level).toBeLessThanOrEqual(JAR_LEVEL_MAX);
      last = level;
    }
    // Gentle: a hundred times the rows is nowhere near a hundred times the liquid.
    expect(liquidLevel(1000) / liquidLevel(10)).toBeLessThan(2);
  });
});

describe("labels", () => {
  it("truncates long names with an ellipsis and keeps short ones", () => {
    expect(truncateName("monsters")).toBe("monsters");
    expect(truncateName("a".repeat(JAR_NAME_MAX_CHARS))).toBe("a".repeat(JAR_NAME_MAX_CHARS));
    const cut = truncateName("billing_invoices_2026");
    expect(Array.from(cut)).toHaveLength(JAR_NAME_MAX_CHARS);
    expect(cut.endsWith("\u2026")).toBe(true);
  });
  it("says rows in the plural, and row for one", () => {
    expect(rowsText(1)).toBe("1 row");
    expect(rowsText(0)).toBe("0 rows");
    expect(rowsText(1234)).toBe("1,234 rows");
    expect(jarAriaLabel("crm_customers", 24)).toBe("Go to table crm_customers, 24 rows");
  });
});

describe("buildJars", () => {
  it("makes no jars for no tables, and one jar per table in order", () => {
    expect(buildJars([], null)).toEqual([]);
    const jars = buildJars([t("crm_customers", 24), t("billing_invoices", 24)], null);
    expect(jars.map((j) => j.name)).toEqual(["crm_customers", "billing_invoices"]);
    expect(jars.map((j) => j.kind)).toEqual(["table", "table"]);
    expect(jars[0].ariaLabel).toBe("Go to table crm_customers, 24 rows");
    expect(jars[1].label).toBe("billing_inv\u2026");
  });
  it("gives a stitched result its own jar, last", () => {
    const jars = buildJars([t("a", 5), t("b", 7)], t("stitch_1_result", 48));
    expect(jars).toHaveLength(3);
    expect(jars[2]).toMatchObject({ kind: "stitched", name: "stitch_1_result", rowCount: 48 });
    expect(new Set(jars.map((j) => j.key)).size).toBe(3);
  });
  it("shows up to six jars with no +N jar", () => {
    const jars = buildJars(many(6), null);
    expect(jars).toHaveLength(SHELF_MAX_JARS);
    expect(jars.some((j) => j.kind === "more")).toBe(false);
    expect(buildJars(many(5), t("stitch_1_result", 3))).toHaveLength(SHELF_MAX_JARS);
  });
  it("shows six jars plus a +N jar when there are more than six tables", () => {
    const jars = buildJars(many(9), null);
    expect(jars).toHaveLength(SHELF_MAX_JARS + 1);
    expect(jars.slice(0, 6).every((j) => j.kind === "table")).toBe(true);
    expect(jars[6]).toMatchObject({ kind: "more", more: 3, label: "+3", ariaLabel: null });
  });
  it("keeps the stitched jar among the six when there are too many tables", () => {
    const jars = buildJars(many(8), t("stitch_1_result", 3));
    expect(jars).toHaveLength(SHELF_MAX_JARS + 1);
    expect(jars[5].kind).toBe("stitched");
    expect(jars[6]).toMatchObject({ kind: "more", more: 3 });
    expect(jars.filter((j) => j.kind === "table")).toHaveLength(5);
  });
  it("clamps every jar's level", () => {
    for (const jar of buildJars([t("tiny", 0), t("huge", 5_000_000)], null)) {
      expect(jar.level).toBeGreaterThanOrEqual(JAR_LEVEL_MIN);
      expect(jar.level).toBeLessThanOrEqual(JAR_LEVEL_MAX);
    }
  });
});

describe("nextCrackleDelayMs", () => {
  it("never allows a crackle sooner than every 20 seconds", () => {
    for (const roll of [0, 0.25, 0.5, 0.999, 1, 5, -3, NaN]) {
      expect(nextCrackleDelayMs(roll)).toBeGreaterThanOrEqual(CRACKLE_MIN_GAP_MS);
    }
  });
});
