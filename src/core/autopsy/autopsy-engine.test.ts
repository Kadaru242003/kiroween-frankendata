/**
 * Pure unit tests for the Autopsy engine helpers and failure paths
 * (Feature 4, tasks 3 and 4). No DuckDB: a stub service stands in.
 */

import { describe, expect, it } from "vitest";
import {
  assembleReport,
  buildColumnFinding,
  epochSecondsToIsoDate,
  runAutopsy,
} from "./autopsy-engine";
import { AUTOPSY_MAX_ROWS, type AutopsyTarget } from "./types";
import type { DuckDBService } from "../types";

const target: AutopsyTarget = {
  tableName: "t",
  schema: [{ name: "a", type: "string" }],
  rowCount: 3,
};

function stubDb(query: DuckDBService["query"]): DuckDBService {
  return {
    init: async () => {},
    createTable: async () => {
      throw new Error("unused");
    },
    getRowCount: async () => 0,
    getPreviewRows: async () => [],
    query,
  };
}

describe("buildColumnFinding", () => {
  it("computes null count and percent from rows and non-null", () => {
    const f = buildColumnFinding({ name: "a", type: "string" }, 10, {
      nonNull: 7,
      distinct: 4,
    });
    expect(f.nullCount).toBe(3);
    expect(f.nullPct).toBeCloseTo(30, 10);
    expect(f.distinct).toBe(4);
  });

  it("reports zero null percent for a table with no rows", () => {
    const f = buildColumnFinding({ name: "a", type: "string" }, 0, {
      nonNull: 0,
      distinct: 0,
    });
    expect(f.nullCount).toBe(0);
    expect(f.nullPct).toBe(0);
    expect(f.status).toBe("healthy");
  });

  it("omits optional fields it was not given (never invents them)", () => {
    const f = buildColumnFinding({ name: "a", type: "string" }, 4, {
      nonNull: 4,
      distinct: 4,
    });
    expect(f).not.toHaveProperty("min");
    expect(f).not.toHaveProperty("topValues");
    expect(f).not.toHaveProperty("conversionFailures");
  });

  it("marks unavailable details in the status reasons", () => {
    const f = buildColumnFinding(
      { name: "a", type: "string" },
      4,
      { nonNull: 4, distinct: 4 },
      { detailsUnavailable: true }
    );
    expect(f.statusReasons).toContain("Some details were unavailable");
  });
});

describe("assembleReport", () => {
  const col = (name: string, rows: number, nonNull: number, distinct: number) =>
    buildColumnFinding({ name, type: "string" }, rows, { nonNull, distinct });

  it("derives candidate keys, all-null, and constant columns", () => {
    const r = assembleReport({
      target,
      rows: 4,
      columns: [col("id", 4, 4, 4), col("empty", 4, 0, 0), col("same", 4, 4, 1), col("mix", 4, 3, 2)],
      duplicateRows: 0,
      fixes: [],
      complete: true,
    });
    expect(r.candidateKeys).toEqual(["id"]);
    expect(r.allNullColumns).toEqual(["empty"]);
    expect(r.constantColumns).toEqual(["same"]);
    expect(r.columnCount).toBe(4);
  });

  it("reports no keys, all-null, or constant columns for an empty table", () => {
    const r = assembleReport({
      target,
      rows: 0,
      columns: [col("a", 0, 0, 0)],
      duplicateRows: 0,
      fixes: [],
      complete: true,
    });
    expect(r.candidateKeys).toEqual([]);
    expect(r.allNullColumns).toEqual([]);
    expect(r.constantColumns).toEqual([]);
    expect(r.health.score).toBe(100);
  });

  it("does not call a single-row table's columns constant", () => {
    const r = assembleReport({
      target,
      rows: 1,
      columns: [col("a", 1, 1, 1)],
      duplicateRows: 0,
      fixes: [],
      complete: true,
    });
    expect(r.constantColumns).toEqual([]);
    expect(r.candidateKeys).toEqual(["a"]);
  });
});

describe("epochSecondsToIsoDate", () => {
  it("converts epoch seconds to a UTC calendar date", () => {
    expect(epochSecondsToIsoDate(Date.UTC(2026, 0, 4) / 1000)).toBe("2026-01-04");
    expect(epochSecondsToIsoDate(0)).toBe("1970-01-01");
  });

  it("rejects non-finite input", () => {
    expect(epochSecondsToIsoDate(Number.NaN)).toBeUndefined();
  });
});

describe("runAutopsy failure paths", () => {
  it("returns a too-large report without running any query", async () => {
    let queried = false;
    const db = stubDb((async () => {
      queried = true;
      return [];
    }) as DuckDBService["query"]);
    const r = await runAutopsy(db, { ...target, rowCount: AUTOPSY_MAX_ROWS + 1 });
    expect(r.status).toBe("too-large");
    expect(r.message).toContain("1,000,000");
    expect(r.columns).toEqual([]);
    expect(queried).toBe(false);
  });

  it("returns a friendly error report when a query fails, never throwing", async () => {
    const db = stubDb((async () => {
      throw new Error("boom");
    }) as DuckDBService["query"]);
    const r = await runAutopsy(db, target);
    expect(r.status).toBe("error");
    expect(r.message).toBeTruthy();
    expect(r.complete).toBe(true);
  });

  it("ignores a throwing progress listener", async () => {
    const db = stubDb((async () => {
      throw new Error("boom");
    }) as DuckDBService["query"]);
    await expect(
      runAutopsy(db, target, {
        onProgress: () => {
          throw new Error("listener");
        },
      })
    ).resolves.toBeTruthy();
  });
});
