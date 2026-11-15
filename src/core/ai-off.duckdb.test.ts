/**
 * AI Off (fully local): with the switch Off, a spied fetch is never called for
 * stitching or Ask. The "What leaves the browser?" text is built from, and
 * checked against, what the payload builders really send.
 */
import { describe, expect, it, vi } from "vitest";
import { createAskController } from "./chat/ask-controller";
import { buildSchemaSummary } from "./chat/schema-builder";
import { createProxySqlProvider } from "./chat/sql-provider";
import { ASK_MAX_QUESTION_CHARS, ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN, ASK_SCHEMA_MAX_SAMPLE_CHARS } from "./chat/types";
import { ASK_THREAD_MAX_TURNS } from "./chat/thread";
import { AI_OFF_ERROR_MESSAGE, gateAiProvider, gateSqlProvider } from "./ai-gate";
import { describeEgress } from "./egress-description";
import { loadBusinessFiles } from "./business-demo";
import { createTestLab } from "./recipes/recipe-test-lab";
import { budgetAiRequest, MAX_COLUMNS, MAX_SAMPLE_CHARS, MAX_SAMPLES_PER_COLUMN } from "./stitching/ai-budget";
import { createProxyAiProvider } from "./stitching/ai-provider";
import { createRulesEngine } from "./stitching/rules-engine";
import { createSampleReader } from "./stitching/sample-reader";
import { createStitchController } from "./stitching/stitch-controller";
import { StitchStore } from "./stitching/stitch-store";
import { AiSwitch } from "../state/ai-switch";

const unavailable = () => new Response("{}", { status: 503 });

describe("AI toggle Off: no request is ever made", () => {
  it("stitching uses the rules engine only and never calls fetch", async () => {
    const lab = await createTestLab();
    try {
      await lab.load(await loadBusinessFiles());
      const fetchFn = vi.fn(async () => unavailable());
      const sw = new AiSwitch();
      const controller = createStitchController({
        db: lab.db,
        getTables: () => lab.tables(),
        store: new StitchStore(),
        aiProvider: gateAiProvider(createProxyAiProvider({ fetchFn: fetchFn as never }), sw),
        aiEnabledFlag: "true",
      });
      sw.set(false);
      const off = await controller.computeProposals();
      expect(off.aiUsed).toBe(false);
      expect(off.matches.length).toBeGreaterThan(0);
      expect(fetchFn).not.toHaveBeenCalled();
      // Positive control: with the switch On the same call does reach fetch.
      sw.set(true);
      await controller.computeProposals();
      expect(fetchFn).toHaveBeenCalled();
    } finally {
      lab.dispose();
    }
  }, 60000);

  it("free-form Ask shows the unavailable outcome and never calls fetch", async () => {
    const fetchFn = vi.fn(async () => unavailable());
    const sw = new AiSwitch();
    const ask = createAskController({
      getQueryableTableNames: () => ["t"],
      runQuery: async () => ({ columns: [], rows: [] }),
      aiEnabled: true,
      provider: gateSqlProvider(createProxySqlProvider({ fetchFn: fetchFn as never }), sw),
      buildSchema: async () => ({ tables: [] }),
    });
    sw.set(false);
    expect((await ask.ask("anything")).kind).toBe("ai-unavailable");
    expect((await ask.ask("follow up", [{ question: "q", sql: "SELECT 1", columns: ["a"], rowCount: 1 }])).kind).toBe("ai-unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
    sw.set(true);
    await ask.ask("anything");
    expect(fetchFn).toHaveBeenCalled();
  });

  it("the off error message is recognised as unavailable", () => {
    expect(AI_OFF_ERROR_MESSAGE).toMatch(/unavailable/);
  });
});

describe("What leaves the browser? matches the payload builders", () => {
  it("the disclosure states the real limits", () => {
    const text = describeEgress().sent.join("\n");
    expect(text).toContain(`up to ${MAX_SAMPLES_PER_COLUMN} short sample values per column (each cut to ${MAX_SAMPLE_CHARS} characters), for at most ${MAX_COLUMNS} columns`);
    expect(text).toContain(`up to ${ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN} short sample values per column (each cut to ${ASK_SCHEMA_MAX_SAMPLE_CHARS} characters)`);
    expect(text).toContain(`at most ${ASK_MAX_QUESTION_CHARS} characters`);
    expect(text).toContain(`at most ${ASK_THREAD_MAX_TURNS} turns`);
    expect(describeEgress().neverSent).toMatch(/rows are never sent/);
  });

  it("real stitching and Ask payloads contain only the described fields, within the described limits", async () => {
    const lab = await createTestLab();
    try {
      await lab.load(await loadBusinessFiles());
      const samples = await createSampleReader(lab.db).readTables(
        lab.tables().map((t) => ({ tableName: t.tableName, schema: t.schema, rowCount: t.rowCount }))
      );
      const matches = createRulesEngine(lab.db).matchAll(samples);
      const budget = budgetAiRequest(matches, samples);
      if (budget.skip) throw new Error("expected a request");
      expect(Object.keys(budget.request).sort()).toEqual(["candidates", "columns"]);
      for (const c of budget.request.columns) {
        expect(Object.keys(c).sort()).toEqual(["columnName", "samples", "tableName", "type"]);
        expect(c.samples.length).toBeLessThanOrEqual(MAX_SAMPLES_PER_COLUMN);
        for (const s of c.samples) expect(s.length).toBeLessThanOrEqual(MAX_SAMPLE_CHARS);
      }
      expect(budget.request.columns.length).toBeLessThanOrEqual(MAX_COLUMNS);
      // Row values only appear as these bounded samples: no other field carries data.
      const schema = await buildSchemaSummary(
        createSampleReader(lab.db),
        lab.tables().map((t) => ({ tableName: t.tableName, columns: t.schema, rowCount: t.rowCount }))
      );
      for (const t of schema.tables) {
        expect(Object.keys(t).sort()).toEqual(["columns", "tableName"]);
        for (const c of t.columns) {
          expect(Object.keys(c).sort()).toEqual(["name", "samples", "type"]);
          expect(c.samples.length).toBeLessThanOrEqual(ASK_SCHEMA_MAX_SAMPLES_PER_COLUMN);
          for (const s of c.samples) expect(s.length).toBeLessThanOrEqual(ASK_SCHEMA_MAX_SAMPLE_CHARS);
        }
      }
    } finally {
      lab.dispose();
    }
  }, 60000);
});
