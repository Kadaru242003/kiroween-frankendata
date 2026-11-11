/**
 * Unit tests for client request payload budgeting (Feature 2, task 19; design:
 * "Client request payload budgeting", "Dev-mode behavior and feature flag").
 *
 * Covers:
 *   - candidate eligibility (only >= MATCH_DISPLAY_THRESHOLD);
 *   - candidate cap (<= 30, lowest-confidence dropped first);
 *   - column cap (<= 40) and per-column sample cap (<= 5 values, <= 40 chars);
 *   - the over-byte-budget skip;
 *   - the VITE_AI_ENABLED flag (isAiEnabled).
 */

import { describe, expect, it } from "vitest";
import type { ColumnType } from "../types";
import {
  MAX_CANDIDATES,
  MAX_COLUMNS,
  MAX_SAMPLES_PER_COLUMN,
  MAX_SAMPLE_CHARS,
  budgetAiRequest,
  isAiEnabled,
  serializedByteLength,
  AI_CANDIDATE_FLOOR,
} from "./ai-budget";
import {
  AI_PROXY_MAX_PAYLOAD_BYTES,
  MATCH_DISPLAY_THRESHOLD,
  type MatchProposal,
  type SampleValue,
  type TableSample,
} from "./types";

function samples(values: (string | null)[]): SampleValue[] {
  return values.map((value, i) => ({ value, count: values.length - i }));
}

function table(
  tableName: string,
  columns: Record<string, { type: ColumnType; values: (string | null)[] }>
): TableSample {
  const samplesByColumn: Record<string, SampleValue[]> = {};
  for (const [name, { values }] of Object.entries(columns)) {
    samplesByColumn[name] = samples(values);
  }
  return {
    tableName,
    rowCount: 100,
    schema: Object.entries(columns).map(([name, { type }]) => ({
      name,
      type,
    })),
    samplesByColumn,
  };
}

function match(
  id: string,
  leftTable: string,
  leftCol: string,
  rightTable: string,
  rightCol: string,
  confidence: number,
  type: ColumnType = "string",
  typeCompat = 1
): MatchProposal {
  return {
    id,
    left: { tableName: leftTable, columnName: leftCol, type },
    right: { tableName: rightTable, columnName: rightCol, type },
    confidence,
    reason: "r",
    source: "rules",
    components: { nameSim: 1, typeCompat, valueOverlap: 1 },
  };
}

describe("isAiEnabled", () => {
  it("is true only for the exact string 'true'", () => {
    expect(isAiEnabled("true")).toBe(true);
  });

  it("is false when unset, false, or any other value", () => {
    expect(isAiEnabled(undefined)).toBe(false);
    expect(isAiEnabled("false")).toBe(false);
    expect(isAiEnabled("")).toBe(false);
    expect(isAiEnabled(true)).toBe(false); // boolean true, not the string
    expect(isAiEnabled("1")).toBe(false);
    expect(isAiEnabled(null)).toBe(false);
  });
});

describe("budgetAiRequest — eligibility", () => {
  it("skips the call when no match is at or above the candidate floor", () => {
    const matches = [
      match("m1", "a", "x", "b", "y", AI_CANDIDATE_FLOOR - 0.01),
    ];
    const tables = [
      table("a", { x: { type: "string", values: ["v"] } }),
      table("b", { y: { type: "string", values: ["v"] } }),
    ];
    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.reason).toBe("no-candidates");
    }
  });

  it("sends compatible-type candidates in [floor, display) as well as >= display (wider floor)", () => {
    const matches = [
      match("hi", "a", "x", "b", "y", 0.9),
      // Discovered tier: rule in [0.25, 0.5) with compatible types.
      match("lo", "a", "x2", "b", "y2", MATCH_DISPLAY_THRESHOLD - 0.001),
    ];
    const tables = [
      table("a", {
        x: { type: "string", values: ["v"] },
        x2: { type: "string", values: ["v"] },
      }),
      table("b", {
        y: { type: "string", values: ["v"] },
        y2: { type: "string", values: ["v"] },
      }),
    ];
    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(false);
    if (!result.skip) {
      // Both sent, highest-confidence first.
      expect(result.request.candidates.map((c) => c.id)).toEqual(["hi", "lo"]);
    }
  });

  it("does NOT send a sub-display candidate with incompatible types (typeCompat == 0)", () => {
    const matches = [
      // Rule 0.4 (>= floor) but types incompatible → must not be sent.
      match("bad", "a", "x", "b", "y", 0.4, "string", 0),
    ];
    const tables = [
      table("a", { x: { type: "string", values: ["v"] } }),
      table("b", { y: { type: "string", values: ["v"] } }),
    ];
    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.reason).toBe("no-candidates");
    }
  });

  it("does NOT send a candidate below the floor (no resurrection path)", () => {
    const matches = [
      match("tiny", "a", "x", "b", "y", AI_CANDIDATE_FLOOR - 0.05),
    ];
    const tables = [
      table("a", { x: { type: "string", values: ["v"] } }),
      table("b", { y: { type: "string", values: ["v"] } }),
    ];
    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(true);
  });

  it("keeps the boundary candidate exactly at the display threshold", () => {
    const matches = [
      match("edge", "a", "x", "b", "y", MATCH_DISPLAY_THRESHOLD),
    ];
    const tables = [
      table("a", { x: { type: "string", values: ["v"] } }),
      table("b", { y: { type: "string", values: ["v"] } }),
    ];
    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.request.candidates).toHaveLength(1);
    }
  });
});

describe("budgetAiRequest — candidate cap", () => {
  it("caps candidates at MAX_CANDIDATES, dropping lowest confidence first", () => {
    // 35 eligible matches drawn from a small shared column pool (20 left + 20
    // right = 40 columns total, within the column cap) so ONLY the candidate
    // cap is exercised here, not the column cap. Confidences descend so the
    // lowest-confidence candidates are the ones dropped.
    const cols: Record<string, { type: ColumnType; values: string[] }> = {};
    const colsB: Record<string, { type: ColumnType; values: string[] }> = {};
    for (let i = 0; i < 20; i += 1) {
      cols[`x${i}`] = { type: "string", values: ["v"] };
      colsB[`y${i}`] = { type: "string", values: ["v"] };
    }
    const matches: MatchProposal[] = [];
    let made = 0;
    // Distinct (x_i, y_j) pairs: 20x20 = 400 available; take the first 35.
    for (let i = 0; i < 20 && made < 35; i += 1) {
      for (let j = 0; j < 20 && made < 35; j += 1) {
        const conf = 0.99 - made * 0.01; // all >= 0.5
        matches.push(
          match(`m${String(made).padStart(2, "0")}`, "a", `x${i}`, "b", `y${j}`, conf)
        );
        made += 1;
      }
    }
    const tables = [table("a", cols), table("b", colsB)];

    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.request.candidates).toHaveLength(MAX_CANDIDATES);
      // The dropped ones are the lowest-confidence (highest index); the kept
      // set is the top-30 by confidence.
      const keptIds = new Set(result.request.candidates.map((c) => c.id));
      expect(keptIds.has("m00")).toBe(true); // highest confidence
      expect(keptIds.has("m34")).toBe(false); // lowest confidence
    }
  });
});

describe("budgetAiRequest — column cap", () => {
  it("never references more than MAX_COLUMNS columns", () => {
    // 30 candidates, each referencing two unique columns = 60 columns, which
    // exceeds the 40-column cap; budgeting must drop candidates until <= 40.
    const matches: MatchProposal[] = [];
    const cols: Record<string, { type: ColumnType; values: string[] }> = {};
    const colsB: Record<string, { type: ColumnType; values: string[] }> = {};
    for (let i = 0; i < 30; i += 1) {
      const conf = 0.99 - i * 0.01;
      cols[`x${i}`] = { type: "string", values: ["v"] };
      colsB[`y${i}`] = { type: "string", values: ["v"] };
      matches.push(match(`m${String(i).padStart(2, "0")}`, "a", `x${i}`, "b", `y${i}`, conf));
    }
    const tables = [table("a", cols), table("b", colsB)];

    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.request.columns.length).toBeLessThanOrEqual(MAX_COLUMNS);
      // 40 columns / 2 per candidate = 20 candidates survive.
      expect(result.request.candidates).toHaveLength(20);
    }
  });
});

describe("budgetAiRequest — sample cap", () => {
  it("sends at most MAX_SAMPLES_PER_COLUMN values, each <= MAX_SAMPLE_CHARS, nulls excluded", () => {
    const longValue = "z".repeat(100);
    const matches = [match("m1", "a", "x", "b", "y", 0.9)];
    const tables = [
      table("a", {
        x: {
          type: "string",
          values: [longValue, "b", null, "c", "d", "e", "f", "g"],
        },
      }),
      table("b", { y: { type: "string", values: ["b", "c"] } }),
    ];
    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(false);
    if (!result.skip) {
      const colX = result.request.columns.find((c) => c.columnName === "x");
      expect(colX).toBeDefined();
      expect(colX!.samples.length).toBeLessThanOrEqual(MAX_SAMPLES_PER_COLUMN);
      // First value truncated to 40 chars.
      expect(colX!.samples[0]).toHaveLength(MAX_SAMPLE_CHARS);
      // No nulls present.
      expect(colX!.samples.every((s) => typeof s === "string")).toBe(true);
    }
  });
});

describe("budgetAiRequest — byte budget", () => {
  it("skips the call when the serialized body exceeds AI_PROXY_MAX_PAYLOAD_BYTES", () => {
    // Build a request that stays WITHIN the candidate (<=30) and column (<=40)
    // caps yet still blows the 20 KiB byte budget: column names are not capped
    // by budgeting, so very long names + max samples push the serialized body
    // over the limit. This exercises the byte-cap skip specifically (not the
    // count caps).
    const longSuffix = "n".repeat(300); // long, un-capped column-name component
    const bigSamples = Array.from({ length: 5 }, () => "q".repeat(MAX_SAMPLE_CHARS));
    const cols: Record<string, { type: ColumnType; values: string[] }> = {};
    const colsB: Record<string, { type: ColumnType; values: string[] }> = {};
    const matches: MatchProposal[] = [];
    for (let i = 0; i < 20; i += 1) {
      const left = `col_${i}_${longSuffix}`;
      const right = `other_${i}_${longSuffix}`;
      cols[left] = { type: "string", values: bigSamples };
      colsB[right] = { type: "string", values: bigSamples };
      matches.push(match(`id${i}`, "a", left, "b", right, 0.9));
    }
    const tables = [table("a", cols), table("b", colsB)];

    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.reason).toBe("over-byte-budget");
    }
  });

  it("sends the call when the body is within the byte budget", () => {
    const matches = [match("m1", "a", "x", "b", "y", 0.9)];
    const tables = [
      table("a", { x: { type: "string", values: ["v1", "v2"] } }),
      table("b", { y: { type: "string", values: ["v1", "v2"] } }),
    ];
    const result = budgetAiRequest(matches, tables);
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(serializedByteLength(result.request)).toBeLessThanOrEqual(
        AI_PROXY_MAX_PAYLOAD_BYTES
      );
    }
  });
});
