/**
 * Unit tests for the deterministic RulesEngine wiring (Feature 2, tasks 6–7).
 *
 * Verifies `createRulesEngine().match` delegates to the scoring algorithm and
 * produces the same symmetric, deduplicated, thresholded proposals, and that
 * `clean` delegates to the cleaning algorithm over the injected DuckDBService.
 */

import { describe, expect, it, vi } from "vitest";
import type { ColumnSchema, ColumnType, DuckDBService } from "../types";
import { createRulesEngine } from "./rules-engine";
import { matchTables } from "./match-scoring";
import { MATCH_DISPLAY_THRESHOLD, type SampleValue, type TableSample } from "./types";

/**
 * A minimal fake DuckDBService. `match` never touches the DB; `clean` issues
 * only COUNT/quantile aggregates, so a stub that returns zero counts suffices
 * for the wiring tests (no duplicates, no outliers → no such proposals).
 */
function fakeDb(): DuckDBService {
  return {
    init: vi.fn(async () => {}),
    createTable: vi.fn(),
    getRowCount: vi.fn(async () => 0),
    getPreviewRows: vi.fn(async () => []),
    query: vi.fn(async () => [{ total: 0, dups: 0, non_null: 0, outliers: 0 }]),
  } as unknown as DuckDBService;
}

function table(
  tableName: string,
  columns: Record<string, { type: ColumnType; values: string[] }>
): TableSample {
  const schema: ColumnSchema[] = Object.entries(columns).map(
    ([name, { type }]) => ({ name, type })
  );
  const samplesByColumn: Record<string, SampleValue[]> = {};
  for (const [name, { values }] of Object.entries(columns)) {
    samplesByColumn[name] = values.map((value) => ({ value, count: 1 }));
  }
  return { tableName, rowCount: 0, schema, samplesByColumn };
}

describe("createRulesEngine", () => {
  const tables: TableSample[] = [
    table("monsters", {
      name: { type: "string", values: ["a", "b", "c", "d", "e"] },
    }),
    table("experiments", {
      name: { type: "string", values: ["a", "b", "c", "d", "e"] },
    }),
  ];

  it("match delegates to the scoring algorithm", () => {
    const engine = createRulesEngine(fakeDb());
    expect(engine.match(tables)).toEqual(matchTables(tables));
  });

  it("match returns only proposals at or above the display threshold", () => {
    const engine = createRulesEngine(fakeDb());
    for (const match of engine.match(tables)) {
      expect(match.confidence).toBeGreaterThanOrEqual(MATCH_DISPLAY_THRESHOLD);
    }
  });

  it("clean delegates to the cleaning algorithm over the injected DuckDBService", async () => {
    const db = fakeDb();
    const engine = createRulesEngine(db);
    // These samples are already clean (no whitespace/case/category variance),
    // and the fake DB reports no duplicates/outliers, so clean yields nothing.
    const proposals = await engine.clean(tables);
    expect(proposals).toEqual([]);
    // clean consulted the DB for the full-column duplicate/outlier counts.
    expect(db.query).toHaveBeenCalled();
  });
});
