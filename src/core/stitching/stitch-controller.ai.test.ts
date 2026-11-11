/**
 * AI-wiring tests for the {@link StitchController} (Feature 2, task 19).
 *
 * These exercise the controller's AI refinement seam with a {@link
 * FakeAiProvider} and injected fakes for the SampleReader / RulesEngine /
 * StitchApplier — NO DuckDB, NO network. They verify the guaranteed rules
 * fallback and the happy-path merge:
 *
 *   - no provider → rules-only, aiUsed = false, provider never called;
 *   - provider present but VITE_AI_ENABLED off → rules-only, no call;
 *   - provider throws/times out → rules result unchanged, aiUsed = false;
 *   - provider returns a mis-shaped body → rules unchanged, aiUsed = false;
 *   - provider returns a valid refinement → bounded merge, aiUsed = true,
 *     payload budgeted (only >= threshold candidates sent).
 */

import { describe, expect, it } from "vitest";
import type { ColumnType, LoadedTable } from "../types";
import { createFakeAiProvider } from "./ai-provider";
import { createStitchController } from "./stitch-controller";
import { StitchStore } from "./stitch-store";
import type { SampleReader, SampleSourceTable } from "./sample-reader";
import type { StitchApplier } from "./stitch-applier";
import {
  MATCH_DISPLAY_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  type MatchProposal,
  type RulesEngine,
  type TableSample,
} from "./types";
import { selectHighConfidenceProposalIds } from "./plan-assembly";

// ── Fakes ────────────────────────────────────────────────────────────────────

function loadedTable(loadId: number, tableName: string): LoadedTable {
  return {
    loadId,
    tableName,
    sourceFileName: `${tableName}.csv`,
    schema: [{ name: "x", type: "string" as ColumnType }],
    rowCount: 10,
  };
}

function fakeSampleReader(result: TableSample[]): SampleReader {
  return {
    readTable: async (t: SampleSourceTable) =>
      result.find((r) => r.tableName === t.tableName) ?? {
        tableName: t.tableName,
        rowCount: t.rowCount,
        schema: t.schema,
        samplesByColumn: {},
      },
    readTables: async () => result,
  };
}

function fakeRulesEngine(
  matches: MatchProposal[],
  fullMatches?: MatchProposal[]
): RulesEngine {
  return {
    match: () => matches,
    // The full scored set for the AI's wider candidate floor; defaults to the
    // display matches when a test does not exercise sub-threshold discovery.
    matchAll: () => fullMatches ?? matches,
    clean: async () => [],
  };
}

const NOOP_APPLIER: StitchApplier = {
  apply: async () => {
    throw new Error("not used in these tests");
  },
  undo: async () => [],
  pendingUndo: () => null,
  nextCounter: () => 1,
};

function match(id: string, confidence: number): MatchProposal {
  return {
    id,
    left: { tableName: "a", columnName: "x", type: "string" },
    right: { tableName: "b", columnName: "y", type: "string" },
    confidence,
    reason: "rules reason",
    source: "rules",
    components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
  };
}

const SAMPLES: TableSample[] = [
  {
    tableName: "a",
    rowCount: 10,
    schema: [{ name: "x", type: "string" }],
    samplesByColumn: { x: [{ value: "v", count: 1 }] },
  },
  {
    tableName: "b",
    rowCount: 10,
    schema: [{ name: "y", type: "string" }],
    samplesByColumn: { y: [{ value: "v", count: 1 }] },
  },
];

interface Harness {
  store: StitchStore;
  controller: ReturnType<typeof createStitchController>;
}

function makeController(options: {
  matches: MatchProposal[];
  // The full scored set (incl. sub-0.5 discovered candidates). Defaults to
  // `matches` when a test does not exercise discovery.
  fullMatches?: MatchProposal[];
  aiProvider?: ReturnType<typeof createFakeAiProvider>;
  aiEnabledFlag?: unknown;
}): Harness {
  const store = new StitchStore();
  const tables = [loadedTable(1, "a"), loadedTable(2, "b")];
  const controller = createStitchController({
    db: {} as never, // never touched: SampleReader/RulesEngine/applier injected
    getTables: () => tables,
    store,
    sampleReader: fakeSampleReader(SAMPLES),
    rulesEngine: fakeRulesEngine(options.matches, options.fullMatches),
    applier: NOOP_APPLIER,
    aiProvider: options.aiProvider,
    aiEnabledFlag: options.aiEnabledFlag,
  });
  return { store, controller };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("StitchController AI wiring — rules-only paths", () => {
  it("runs rules-only (aiUsed=false) when no provider is injected", async () => {
    const { controller } = makeController({ matches: [match("m1", 0.9)] });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(false);
    expect(result.matches[0].source).toBe("rules");
    expect(result.matches[0].confidence).toBe(0.9);
  });

  it("never calls the provider when VITE_AI_ENABLED is off", async () => {
    const ai = createFakeAiProvider({
      behavior: {
        kind: "respond",
        response: { refinements: [{ id: "m1", confidence: 1, reason: "r" }] },
      },
    });
    const { controller } = makeController({
      matches: [match("m1", 0.9)],
      aiProvider: ai,
      aiEnabledFlag: undefined, // off
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(false);
    expect(ai.calls).toHaveLength(0);
    expect(result.matches[0].confidence).toBe(0.9);
  });

  it("never calls the provider when the flag is the boolean true (not 'true')", async () => {
    const ai = createFakeAiProvider();
    const { controller } = makeController({
      matches: [match("m1", 0.9)],
      aiProvider: ai,
      aiEnabledFlag: true,
    });
    await controller.computeProposals();
    expect(ai.calls).toHaveLength(0);
  });
});

describe("StitchController AI wiring — guaranteed fallback", () => {
  it("falls back to rules when the provider throws", async () => {
    const ai = createFakeAiProvider({
      behavior: { kind: "throw", error: new Error("boom") },
    });
    const { controller } = makeController({
      matches: [match("m1", 0.9)],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(false);
    expect(result.matches[0].source).toBe("rules");
    expect(result.matches[0].confidence).toBe(0.9);
    expect(ai.calls).toHaveLength(1); // it WAS called, then fell back
  });

  it("falls back when the provider times out (abort-like rejection)", async () => {
    const ai = createFakeAiProvider({
      behavior: {
        kind: "fn",
        fn: () =>
          Promise.reject(new DOMException("Aborted", "AbortError")),
      },
    });
    const { controller } = makeController({
      matches: [match("m1", 0.9)],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(false);
    expect(result.matches[0].confidence).toBe(0.9);
  });

  it("falls back when the provider returns a mis-shaped body", async () => {
    const ai = createFakeAiProvider({
      behavior: {
        kind: "fn",
        fn: () => ({ nope: true }) as never,
      },
    });
    const { controller } = makeController({
      matches: [match("m1", 0.9)],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(false);
    expect(result.matches[0].source).toBe("rules");
  });

  it("skips the call with no user-facing error when there are no eligible candidates", async () => {
    const ai = createFakeAiProvider();
    const { controller } = makeController({
      // Rules engine returns nothing >= threshold; nothing to send.
      matches: [],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(false);
    expect(ai.calls).toHaveLength(0);
  });
});

describe("StitchController AI wiring — happy path merge", () => {
  it("merges a bounded refinement and sets aiUsed=true, source=ai", async () => {
    const ai = createFakeAiProvider({
      behavior: {
        kind: "respond",
        response: {
          refinements: [{ id: "m1", confidence: 1, reason: "AI says strong" }],
        },
      },
    });
    const { controller } = makeController({
      matches: [match("m1", 0.7)],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(true);
    expect(result.matches[0].source).toBe("ai");
    // Bounded +0.2 from 0.7 → 0.9.
    expect(result.matches[0].confidence).toBeCloseTo(0.9, 10);
    expect(result.matches[0].reason).toBe("AI says strong");
    // Only the eligible candidate was sent.
    expect(ai.calls[0].candidates.map((c) => c.id)).toEqual(["m1"]);
  });

  it("hides a match the AI demotes below the display threshold", async () => {
    const ai = createFakeAiProvider({
      behavior: {
        kind: "respond",
        response: {
          // Drive m1 from 0.55 down by the full -0.2 to 0.35 (< 0.5).
          refinements: [{ id: "m1", confidence: 0, reason: "weak" }],
        },
      },
    });
    const { controller } = makeController({
      matches: [match("m1", MATCH_DISPLAY_THRESHOLD + 0.05)],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(true);
    // Demoted below threshold → hidden from the display set.
    expect(result.matches).toHaveLength(0);
  });
});

describe("StitchController AI wiring — AI discovery (wider floor + two-tier lift)", () => {
  it("discovers a sub-0.5 candidate, lifts it to >= 0.5, marks aiDiscovered, source=ai", async () => {
    // Rule 0.4 (discovered tier). The full set carries it; the display base
    // does not (so it starts hidden). The AI lifts it by +0.3 → 0.7.
    const discovered = match("disc", 0.4);
    const ai = createFakeAiProvider({
      behavior: {
        kind: "respond",
        response: {
          refinements: [
            { id: "disc", confidence: 1, reason: "shared High/Low values" },
          ],
        },
      },
    });
    const { controller } = makeController({
      matches: [], // nothing visible from the rules alone
      fullMatches: [discovered],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    expect(result.aiUsed).toBe(true);
    expect(ai.calls).toHaveLength(1);
    const disc = result.matches.find((m) => m.id === "disc");
    expect(disc).toBeDefined();
    expect(disc!.source).toBe("ai");
    expect(disc!.aiDiscovered).toBe(true);
    // +0.3 lift cap: 0.4 → 0.7 (clamp of ai−rule to +0.3).
    expect(disc!.confidence).toBeCloseTo(0.7, 10);
    expect(disc!.reason).toBe("shared High/Low values");
  });

  it("ignores a discovered lift that has NO reason (keeps it hidden)", async () => {
    const discovered = match("disc", 0.4);
    const ai = createFakeAiProvider({
      behavior: {
        kind: "respond",
        response: {
          // Empty reason → invalid for a discovered candidate → rule kept.
          refinements: [{ id: "disc", confidence: 1, reason: "   " }],
        },
      },
    });
    const { controller } = makeController({
      matches: [],
      fullMatches: [discovered],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    // The lift was rejected, so nothing surfaced and aiUsed stays false.
    expect(result.aiUsed).toBe(false);
    expect(result.matches.find((m) => m.id === "disc")).toBeUndefined();
  });

  it("a discovered match never reaches HIGH_CONFIDENCE_THRESHOLD (not auto-approvable)", async () => {
    // Even a max-boost AI can only lift a 0.49 discovered match by +0.3 →
    // 0.79 < 0.85, so "Approve all high-confidence" (>= 0.85) never selects it.
    const discovered = match("disc", 0.49);
    const ai = createFakeAiProvider({
      behavior: {
        kind: "respond",
        response: {
          refinements: [
            { id: "disc", confidence: 1, reason: "values line up exactly" },
          ],
        },
      },
    });
    const { controller } = makeController({
      matches: [],
      fullMatches: [discovered],
      aiProvider: ai,
      aiEnabledFlag: "true",
    });
    const result = await controller.computeProposals();
    const disc = result.matches.find((m) => m.id === "disc")!;
    expect(disc.aiDiscovered).toBe(true);
    expect(disc.confidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD);
    // selectHighConfidenceProposalIds would NOT include it.
    expect(
      selectHighConfidenceProposalIds(result.matches).includes("disc")
    ).toBe(false);
  });
});
