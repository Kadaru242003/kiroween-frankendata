/**
 * Property-based test for the guaranteed rules fallback on AI failure.
 *
 * Feature: frankendata-ai-stitching, Property 7: AI failure falls back to rules
 *
 * Validates: Requirements 6.5, 6.6, 10.6
 *
 * Property 7 statement: For any input, when the `AiProvider` throws, times out,
 * or rejects, the engine returns the rules-engine result and does not propagate
 * the failure. The design strengthens this to the full set of ways the AI can
 * misbehave (design: "Error Handling" — AI unavailable on timeout, non-200,
 * network, malformed, or fully-invalid response; guaranteed rules fallback):
 * whatever the AI does, the controller's resulting {@link ProposalSet} is
 * EXACTLY the rules-only result — same matches (ids, confidences, reasons,
 * sources, components), same cleanings — with `aiUsed = false`, and no error
 * escapes `computeProposals`.
 *
 * ## Proof strategy
 *
 * For each arbitrary generated input (tables + rules matches + cleanings), the
 * test computes a *rules-only baseline* ProposalSet by running the controller
 * with NO provider injected (the deterministic path, aiUsed = false), then runs
 * the SAME input through a controller whose injected {@link FakeAiProvider} is
 * configured to fail in one of the enumerated misbehaviors:
 *
 *   - throw synchronously / reject asynchronously;
 *   - time out (an `AbortError` rejection, as the real timeout surfaces);
 *   - return a non-object / wrong-shaped / non-`{refinements:[]}` body
 *     (the "non-200/malformed" family, which the validator treats as a total
 *     failure since the provider only ever yields a parsed body here);
 *   - return a body so large it mirrors an over-budget/garbage response.
 *
 * It then asserts the two ProposalSets are deeply equal and `aiUsed === false`.
 * Because the baseline is the literal rules output, deep-equality proves the
 * fallback is byte-for-byte the rules result regardless of the AI's behavior.
 *
 * This is a pure-logic property: no DuckDB, no network. The SampleReader and
 * RulesEngine are injected fakes (matching the Feature-1/Task-19 convention of
 * exercising the controller's orchestration in isolation), and every provider
 * is a {@link FakeAiProvider} that never touches the network (Req 6.7, 10.7).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ColumnSchema, ColumnType, LoadedTable } from "../types";
import { createFakeAiProvider, type FakeAiBehavior } from "./ai-provider";
import { createStitchController } from "./stitch-controller";
import { StitchStore } from "./stitch-store";
import type { SampleReader, SampleSourceTable } from "./sample-reader";
import type { StitchApplier } from "./stitch-applier";
import type {
  CleaningProposal,
  MatchProposal,
  ProposalSet,
  RulesEngine,
  SampleValue,
  TableSample,
} from "./types";

/** Property-test iteration count (design: fast-check, >= 100 iterations). */
const NUM_RUNS = 150;

const ALL_TYPES: ColumnType[] = ["number", "boolean", "date", "string"];

// ── Injected fakes (no DuckDB, no network) ───────────────────────────────────

/** A StitchApplier that is never invoked (computeProposals does not apply). */
const NOOP_APPLIER: StitchApplier = {
  apply: async () => {
    throw new Error("applier.apply must not be called by computeProposals");
  },
  undo: async () => [],
  pendingUndo: () => null,
  nextCounter: () => 1,
};

/** A SampleReader that echoes a fixed set of generated {@link TableSample}s. */
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

/** A RulesEngine that returns fixed generated matches + cleanings. */
function fakeRulesEngine(
  matches: MatchProposal[],
  cleanings: CleaningProposal[]
): RulesEngine {
  return {
    match: () => matches,
    matchAll: () => matches,
    clean: async () => cleanings,
  };
}

/** Build a controller over the generated input with an optional AI provider. */
function makeController(input: {
  tables: LoadedTable[];
  samples: TableSample[];
  matches: MatchProposal[];
  cleanings: CleaningProposal[];
  aiProvider?: ReturnType<typeof createFakeAiProvider>;
  aiEnabledFlag?: unknown;
}) {
  const store = new StitchStore();
  return createStitchController({
    db: {} as never, // never touched: reader/engine/applier are injected
    getTables: () => input.tables,
    store,
    sampleReader: fakeSampleReader(input.samples),
    rulesEngine: fakeRulesEngine(input.matches, input.cleanings),
    applier: NOOP_APPLIER,
    aiProvider: input.aiProvider,
    aiEnabledFlag: input.aiEnabledFlag,
  });
}

// ── Generators ───────────────────────────────────────────────────────────────

const tableName = fc.constantFrom("monsters", "experiments", "lab_log", "intake");
const columnName = fc.constantFrom("name", "id", "status", "score", "created_at");
const columnType: fc.Arbitrary<ColumnType> = fc.constantFrom(...ALL_TYPES);

const sampleValue: fc.Arbitrary<SampleValue> = fc.record({
  value: fc.oneof(fc.string({ maxLength: 16 }), fc.constant<string | null>(null)),
  count: fc.integer({ min: 1, max: 50 }),
});

/** Two distinctly-named tables with 1..4 uniquely-named columns each. */
const genTwoTables: fc.Arbitrary<{
  tables: LoadedTable[];
  samples: TableSample[];
}> = fc
  .uniqueArray(
    fc.record({
      name: tableName,
      loadId: fc.integer({ min: 1, max: 1000 }),
      columns: fc.uniqueArray(
        fc.record({ name: columnName, type: columnType }),
        { minLength: 1, maxLength: 4, selector: (c) => c.name }
      ),
      samples: fc.array(sampleValue, { maxLength: 10 }),
    }),
    { minLength: 2, maxLength: 2, selector: (t) => t.name }
  )
  .map((defs) => {
    // Distinct loadIds so datasetVersion is well-formed.
    const withIds = defs.map((d, i) => ({ ...d, loadId: d.loadId + i * 1009 }));
    const tables: LoadedTable[] = withIds.map((d) => {
      const schema: ColumnSchema[] = d.columns.map((c) => ({
        name: c.name,
        type: c.type,
      }));
      return {
        loadId: d.loadId,
        tableName: d.name,
        sourceFileName: `${d.name}.csv`,
        schema,
        rowCount: 10,
      };
    });
    const samples: TableSample[] = withIds.map((d) => {
      const schema: ColumnSchema[] = d.columns.map((c) => ({
        name: c.name,
        type: c.type,
      }));
      const samplesByColumn: Record<string, SampleValue[]> = {};
      for (const c of d.columns) {
        samplesByColumn[c.name] = d.samples;
      }
      return { tableName: d.name, rowCount: 10, schema, samplesByColumn };
    });
    return { tables, samples };
  });

/** A rules MatchProposal across the two generated tables. */
function genMatch(tables: LoadedTable[]): fc.Arbitrary<MatchProposal> {
  const [a, b] = tables;
  return fc.record({
    leftCol: fc.constantFrom(...a.schema.map((c) => c.name)),
    rightCol: fc.constantFrom(...b.schema.map((c) => c.name)),
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    reason: fc.string({ maxLength: 40 }),
    nameSim: fc.double({ min: 0, max: 1, noNaN: true }),
    typeCompat: fc.double({ min: 0, max: 1, noNaN: true }),
    valueOverlap: fc.double({ min: 0, max: 1, noNaN: true }),
  }).map((r): MatchProposal => {
    const leftType = a.schema.find((c) => c.name === r.leftCol)!.type;
    const rightType = b.schema.find((c) => c.name === r.rightCol)!.type;
    return {
      id: `${a.tableName}.${r.leftCol}|${b.tableName}.${r.rightCol}`,
      left: { tableName: a.tableName, columnName: r.leftCol, type: leftType },
      right: { tableName: b.tableName, columnName: r.rightCol, type: rightType },
      confidence: r.confidence,
      reason: r.reason,
      source: "rules",
      components: {
        nameSim: r.nameSim,
        typeCompat: r.typeCompat,
        valueOverlap: r.valueOverlap,
      },
    };
  });
}

/** A rules CleaningProposal for one of the generated tables. */
function genCleaning(tables: LoadedTable[]): fc.Arbitrary<CleaningProposal> {
  return fc
    .record({
      tableIdx: fc.integer({ min: 0, max: tables.length - 1 }),
      kind: fc.constantFrom(
        "whitespace-case" as const,
        "category-standardize" as const,
        "duplicate-rows" as const,
        "outliers" as const
      ),
      before: fc.string({ maxLength: 20 }),
      after: fc.string({ maxLength: 20 }),
      reason: fc.string({ maxLength: 40 }),
      seq: fc.integer({ min: 0, max: 9999 }),
    })
    .map((r): CleaningProposal => {
      const t = tables[r.tableIdx];
      const columnName = r.kind === "duplicate-rows" ? undefined : t.schema[0].name;
      return {
        id: `clean-${t.tableName}-${r.seq}`,
        target: { tableName: t.tableName, columnName },
        kind: r.kind,
        before: r.before,
        after: r.after,
        reason: r.reason,
      };
    });
}

/** The full generated input: tables + rules matches + rules cleanings. */
const genInput = genTwoTables.chain(({ tables, samples }) =>
  fc
    .record({
      matches: fc.uniqueArray(genMatch(tables), {
        maxLength: 6,
        selector: (m: MatchProposal) => m.id,
      }),
      cleanings: fc.uniqueArray(genCleaning(tables), {
        maxLength: 5,
        selector: (c: CleaningProposal) => c.id,
      }),
    })
    .map(({ matches, cleanings }) => ({ tables, samples, matches, cleanings }))
);

/**
 * The enumerated ways the AI can misbehave — every one must land on the exact
 * rules result. Each is a factory so a fresh provider is built per run.
 */
const FAILURE_BEHAVIORS: ReadonlyArray<{
  label: string;
  behavior: () => FakeAiBehavior;
}> = [
  {
    label: "throws synchronously",
    behavior: () => ({ kind: "throw", error: new Error("boom") }),
  },
  {
    label: "rejects asynchronously",
    behavior: () => ({ kind: "fn", fn: () => Promise.reject(new Error("nope")) }),
  },
  {
    label: "times out (AbortError)",
    behavior: () => ({
      kind: "fn",
      fn: () => Promise.reject(new DOMException("Aborted", "AbortError")),
    }),
  },
  {
    label: "returns null body",
    behavior: () => ({ kind: "fn", fn: () => null as never }),
  },
  {
    label: "returns a non-object body",
    behavior: () => ({ kind: "fn", fn: () => "not json" as never }),
  },
  {
    label: "returns a wrong-shaped object (no refinements array)",
    behavior: () => ({ kind: "fn", fn: () => ({ oops: true }) as never }),
  },
  {
    label: "returns refinements that is not an array",
    behavior: () => ({
      kind: "fn",
      fn: () => ({ refinements: "nope" }) as never,
    }),
  },
  {
    label: "returns a huge garbage body",
    behavior: () => ({
      kind: "fn",
      fn: () => ({ refinements: "x".repeat(100000) }) as never,
    }),
  },
];

// ── The property ───────────────────────────────────────────────────────────

describe("Property 7: AI failure falls back to rules", () => {
  it("every AI misbehavior yields exactly the rules result with aiUsed=false", async () => {
    await fc.assert(
      fc.asyncProperty(
        genInput,
        fc.constantFrom(...FAILURE_BEHAVIORS),
        async (input, failure) => {
          // Baseline: the deterministic rules-only ProposalSet (no provider).
          const rulesOnly: ProposalSet = await makeController({
            tables: input.tables,
            samples: input.samples,
            matches: input.matches,
            cleanings: input.cleanings,
          }).computeProposals();

          // The rules-only path must itself report no AI.
          expect(rulesOnly.aiUsed).toBe(false);

          // Same input, but with a failing AI provider wired in + flag ON.
          const ai = createFakeAiProvider({ behavior: failure.behavior() });
          const withFailingAi: ProposalSet = await makeController({
            tables: input.tables,
            samples: input.samples,
            matches: input.matches,
            cleanings: input.cleanings,
            aiProvider: ai,
            aiEnabledFlag: "true",
          }).computeProposals();

          // The failure never propagated (computeProposals resolved), the
          // result is flagged as a fallback, and it is byte-for-byte the rules
          // result: same matches (ids, confidences, reasons, sources,
          // components) and same cleanings.
          expect(withFailingAi.aiUsed).toBe(false);
          expect(withFailingAi).toEqual(rulesOnly);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("holds even when every match is above the display threshold (candidates were sent)", async () => {
    // Force at least one eligible candidate so the provider is actually called
    // (not skipped by budgeting), then fail — still exactly the rules result.
    await fc.assert(
      fc.asyncProperty(
        genTwoTables,
        fc.constantFrom(...FAILURE_BEHAVIORS),
        async ({ tables, samples }, failure) => {
          const [a, b] = tables;
          const highMatch: MatchProposal = {
            id: `${a.tableName}.${a.schema[0].name}|${b.tableName}.${b.schema[0].name}`,
            left: { tableName: a.tableName, columnName: a.schema[0].name, type: a.schema[0].type },
            right: { tableName: b.tableName, columnName: b.schema[0].name, type: b.schema[0].type },
            confidence: 0.95, // well above MATCH_DISPLAY_THRESHOLD → a candidate
            reason: "strong rules match",
            source: "rules",
            components: { nameSim: 1, typeCompat: 1, valueOverlap: 1 },
          };

          const rulesOnly = await makeController({
            tables,
            samples,
            matches: [highMatch],
            cleanings: [],
          }).computeProposals();

          const ai = createFakeAiProvider({ behavior: failure.behavior() });
          const withFailingAi = await makeController({
            tables,
            samples,
            matches: [highMatch],
            cleanings: [],
            aiProvider: ai,
            aiEnabledFlag: "true",
          }).computeProposals();

          // The provider WAS called (a candidate was eligible), then the
          // failure fell back to the untouched rules result.
          expect(ai.calls.length).toBe(1);
          expect(withFailingAi.aiUsed).toBe(false);
          expect(withFailingAi).toEqual(rulesOnly);
          expect(withFailingAi.matches[0].source).toBe("rules");
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
