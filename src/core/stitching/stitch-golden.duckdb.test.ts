/**
 * Golden-example regression anchor for the stitching engine (Feature 2, task
 * 17).
 *
 * Design: "Golden example (regression anchor)". Requirements 1.2 (fuzzy
 * name/type/value matching bridges differing headers), 1.5 (never match
 * incompatible types — the boolean hard-gate), and 8.5 (the mismatched demo
 * dataset's proposals are produced in under 2 seconds).
 *
 * This is an EXAMPLE-based regression test (no fuzzing): it pins the concrete,
 * end-to-end behaviour of the real pipeline on the two bundled demo datasets,
 * so a future change to normalization, damping, or the gates that reintroduces
 * a known false positive — or drops the expected match — fails loudly.
 *
 * ## What "the real pipeline" means here
 *
 * The test exercises the exact collaborators the app uses, with nothing faked:
 *   1. {@link demoDataLoader.loadMismatched} + {@link demoDataLoader.load}
 *      produce the real bundled {@link File} objects (no network).
 *   2. The real {@link createIntakeController} routes every file through
 *      detect → size → parse → infer → sanitize → {@link createDuckDBService}
 *      (a real in-memory DuckDB), publishing {@link LoadedTable}s to a real
 *      {@link IntakeStore} (which stamps the `loadId`s).
 *   3. The real {@link createStitchController} runs SampleReader → RulesEngine
 *      over those loaded tables to produce the {@link ProposalSet}.
 *
 * ## Table names
 *
 * Both demo datasets happen to use the file names `monsters.csv` and
 * `experiments.csv`. The intake controller de-duplicates table names WITHIN a
 * single `intake()` call, so loading all files in one call keeps the first
 * occurrences unsuffixed and suffixes later collisions (`monsters_2`, …). We
 * load the MISMATCHED dataset first so its tables keep the clean `monsters` /
 * `experiments` names the design's golden assertion refers to
 * (`monsters."Monster Name"` ↔ `experiments.monster_name`); the three Feature-1 demo
 * files then land as `monsters_2`, `experiments_2`, `lab_inventory`.
 *
 * Column names are sanitized case-PRESERVING (`Monster Name` → `Monster_Name`,
 * `Species` → `Species`, `monster_name` → `monster_name`, `hazardous` →
 * `hazardous`), while
 * table names are lowercased.
 *
 * ## Environment note (same pattern as stitch-controller.duckdb.test.ts)
 *
 * DuckDB-WASM's browser bundles need a real browser worker environment that is
 * unavailable under Vitest's jsdom runner, so this test wraps the node-blocking
 * bundle in a DuckDBConnectionAdapter and injects it via createDuckDBService.
 *
 * ## Timing (Req 8.5)
 *
 * The <2s budget is asserted around the proposal-PRODUCTION step only
 * (`computeProposals`), NOT the one-time DuckDB-WASM instantiation or the
 * intake load. Those happen once at app start / file drop and are not part of
 * "producing proposals"; measuring them would conflate a fixed wasm cold-start
 * with the engine's work. The small demo data makes even this isolated budget
 * very comfortable.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import { createIntakeController } from "../intake-controller";
import { demoDataLoader } from "../demo-data-loader";
import { IntakeStore } from "../../state/intake-store";
import { StitchStore } from "./stitch-store";
import { createStitchController } from "./stitch-controller";
import { createFakeAiProvider } from "./ai-provider";
import type { AiRequest, AiResponse } from "./types";
import { HIGH_CONFIDENCE_THRESHOLD } from "./types";
import type {
  ApprovalDecision,
  MatchProposal,
  Proposal,
  ProposalSet,
} from "./types";
import {
  assembleStitchPlan,
  selectHighConfidenceProposalIds,
} from "./plan-assembly";

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs") as {
  createDuckDB: (
    bundles: unknown,
    logger: unknown,
    runtime: unknown,
  ) => Promise<DuckDBNodeInstance>;
  NODE_RUNTIME: unknown;
  VoidLogger: new () => unknown;
  DuckDBAccessMode: { READ_WRITE: number };
};

interface DuckDBConnectionLike {
  query(text: string): { toArray(): Array<{ toJSON(): Record<string, unknown> }> };
  close(): void;
}

interface DuckDBNodeInstance {
  instantiate(): Promise<unknown>;
  open(config: { path?: string; accessMode?: number }): void;
  connect(): DuckDBConnectionLike;
  reset(): void;
}

const DUCKDB_DIST = path.dirname(
  require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"),
);

const bundles = {
  mvp: {
    mainModule: path.join(DUCKDB_DIST, "duckdb-mvp.wasm"),
    mainWorker: path.join(DUCKDB_DIST, "duckdb-node-mvp.worker.cjs"),
  },
};

async function createNodeAdapter(): Promise<{
  adapter: DuckDBConnectionAdapter;
  dispose: () => void;
}> {
  const db = await duckdb.createDuckDB(
    bundles,
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  db.open({ path: ":memory:", accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  const conn = db.connect();
  const adapter: DuckDBConnectionAdapter = {
    async run(sql: string) {
      return conn.query(sql).toArray().map((r) => r.toJSON());
    },
  };
  return {
    adapter,
    dispose: () => {
      conn.close();
      db.reset();
    },
  };
}

/** Find a symmetric match for an unordered {table,column} ↔ {table,column} pair. */
function findMatch(
  matches: readonly MatchProposal[],
  a: { table: string; column: string },
  b: { table: string; column: string },
): MatchProposal | undefined {
  const sides = (m: MatchProposal) => [
    { table: m.left.tableName, column: m.left.columnName },
    { table: m.right.tableName, column: m.right.columnName },
  ];
  return matches.find((m) => {
    const [l, r] = sides(m);
    const forward =
      l.table === a.table &&
      l.column === a.column &&
      r.table === b.table &&
      r.column === b.column;
    const backward =
      l.table === b.table &&
      l.column === b.column &&
      r.table === a.table &&
      r.column === a.column;
    return forward || backward;
  });
}

describe("Golden example — real pipeline stitching regression (Design: Golden example; Requirements 1.2, 1.5, 8.5)", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  // Shared across the assertions so we load + compute exactly once.
  let proposals: ProposalSet;
  let matches: readonly MatchProposal[];
  let computeMs = 0;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());

    const service = createDuckDBService(adapter);
    await service.init();

    // 1. Materialize BOTH bundled demo datasets (no network). The mismatched
    //    set goes first so its tables keep the clean `monsters` / `experiments`
    //    names the golden assertion refers to.
    const [mismatched, feature1] = await Promise.all([
      demoDataLoader.loadMismatched(),
      demoDataLoader.load(),
    ]);

    // 2. Route every file through the REAL intake pipeline in a single call so
    //    the sanitizer de-duplicates the shared file names deterministically.
    const store = new IntakeStore();
    const intake = createIntakeController({ duckDBService: service, store });
    await intake.intake([...mismatched, ...feature1]);

    // Every file must have loaded cleanly (no intake errors), or the golden
    // signal would be meaningless.
    expect(store.getState().errors).toEqual([]);
    expect(store.getState().tables).toHaveLength(5);

    // 3. Run the REAL stitch controller (SampleReader → RulesEngine) over the
    //    loaded tables. Time ONLY this proposal-production step (Req 8.5).
    const stitchStore = new StitchStore();
    const controller = createStitchController({
      db: service,
      getTables: () => store.getState().tables,
      store: stitchStore,
    });

    const start = performance.now();
    proposals = await controller.computeProposals();
    computeMs = performance.now() - start;

    matches = proposals.matches;
    // No AI provider injected → purely the deterministic rules result.
    expect(proposals.aiUsed).toBe(false);
  });

  afterAll(() => {
    dispose?.();
  });

  it("surfaces the EXPECTED headline match monsters.\"Monster Name\" ↔ experiments.monster_name at HIGH confidence (Req 1.2, 3.3)", () => {
    // Bridges differently-cased headers (Monster Name ↔ monster_name) that
    // normalize to the same tokens, so nameSim = 1; with 12 distinct names
    // overlapping on both sides the value-overlap damping is lifted, so the
    // confidence clears HIGH_CONFIDENCE_THRESHOLD — which is what enables the
    // approval screen's "Approve all high-confidence" action.
    const match = findMatch(
      matches,
      { table: "monsters", column: "Monster_Name" },
      { table: "experiments", column: "monster_name" },
    );
    expect(match).toBeDefined();
    expect(match!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
    expect(match!.components.valueOverlap).toBeGreaterThan(0);
    expect(typeof match!.reason).toBe("string");
    expect(match!.source).toBe("rules");
  });

  it("surfaces the species pair monsters.Species ↔ experiments.species above threshold (Req 1.2)", () => {
    const match = findMatch(
      matches,
      { table: "monsters", column: "Species" },
      { table: "experiments", column: "species" },
    );
    expect(match).toBeDefined();
    expect(match!.confidence).toBeGreaterThan(0.5);
    expect(match!.source).toBe("rules");
  });

  it("RULES-ONLY leaves experiments.danger_level UNMATCHED (rule ~0.48, below the 0.5 display threshold)", () => {
    // danger_level shares exactly one token (`level`) with monsters\u2019
    // Threat_Level, so nameSim ~0.38 (over the 0.2 gate) and the full rule
    // confidence lands at ~0.48 — below the 0.5 DISPLAY threshold. With no
    // AI, danger_level is simply unmatched and nothing breaks. (The AI
    // DISCOVERY of this exact pair is covered in the AI golden describe
    // below.)
    const anyDangerLevel = matches.some(
      (m) =>
        m.left.columnName === "danger_level" ||
        m.right.columnName === "danger_level",
    );
    expect(anyDangerLevel).toBe(false);
  });

  it("does NOT surface the BOGUS boolean match sedated ↔ hazardous (Req 1.5 — boolean hard-gate)", () => {
    // Both columns are boolean; the engine's hard gate excludes any pair where
    // either side is boolean, regardless of incidental value overlap (yes/no,
    // true/false all fold to the same two tokens). A match here would be a
    // false positive, so its ABSENCE is pinned.
    const bogus = findMatch(
      matches,
      { table: "monsters", column: "Sedated" },
      { table: "experiments", column: "hazardous" },
    );
    expect(bogus).toBeUndefined();

    // Belt-and-braces: NO surfaced match may involve either boolean column, in
    // any pairing across all five tables.
    const touchesBoolean = matches.some((m) => {
      const cols = [m.left.columnName, m.right.columnName];
      return cols.includes("Sedated") || cols.includes("hazardous");
    });
    expect(touchesBoolean).toBe(false);
  });

  it("every surfaced match is at or above the display threshold with a bounded confidence (Req 1.2)", () => {
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m.confidence).toBeGreaterThanOrEqual(0.5);
      expect(m.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("produces the proposals in under 2 seconds (Req 8.5)", () => {
    // Measured around computeProposals only; DuckDB-WASM instantiation and the
    // intake load are one-time costs excluded from the "produce proposals"
    // budget (see the file header). The small demo data keeps this comfortable.
    expect(computeMs).toBeLessThan(2000);
  });
});


describe("Golden example — apply all approved proposals (Design: Apply; Req 4.1, 7.1, 7.9)", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;
  let service: ReturnType<typeof createDuckDBService>;
  let stitchStore: StitchStore;
  let stitchedRowCount = 0;
  let fanOutAnchor = 0;
  let fanOutResult = 0;
  let fannedOut = true;
  let resultColumns: string[] = [];
  let resultRows: Record<string, unknown>[] = [];

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
    service = createDuckDBService(adapter);
    await service.init();

    // Load ONLY the mismatched pair so the stitch is the clean two-table join
    // the assertion is about (monsters ⨝ experiments on monster_name).
    const mismatched = await demoDataLoader.loadMismatched();
    const store = new IntakeStore();
    const intake = createIntakeController({ duckDBService: service, store });
    await intake.intake(mismatched);
    expect(store.getState().errors).toEqual([]);
    expect(store.getState().tables).toHaveLength(2);

    stitchStore = new StitchStore();
    const controller = createStitchController({
      db: service,
      getTables: () => store.getState().tables,
      store: stitchStore,
    });

    const proposals = await controller.computeProposals();

    // Approve EVERY proposal (both matches and cleanups), mirroring the
    // approval screen's "Approve all suggestions" action.
    const all: Proposal[] = [...proposals.matches, ...proposals.cleanings];
    const decisions: Record<string, ApprovalDecision> = {};
    for (const proposal of all) {
      decisions[proposal.id] = {
        proposalId: proposal.id,
        decision: "approved",
      };
    }
    const plan = assembleStitchPlan(
      proposals,
      decisions,
      store.getState().tables,
    );

    const stitched = await controller.applyPlan(plan);
    stitchedRowCount = stitched.rowCount;
    const fanOut = stitchStore.getState().fanOut!;
    fanOutAnchor = fanOut.anchorRowCount;
    fanOutResult = fanOut.resultRowCount;
    fannedOut = fanOut.fannedOut;

    // Capture the stitched result's column names (in order) and all rows so
    // the row-by-row category-agreement assertion can run on real data.
    resultColumns = stitched.schema.map((c) => c.name);
    resultRows = await service.query<Record<string, unknown>>(
      `SELECT * FROM ${stitched.tableName}`,
    );
  });

  afterAll(() => {
    dispose?.();
  });

  it("stitched result has 12 rows with NO fan-out (anchor 12 in, 12 out)", () => {
    // Each file carries 12 distinct creatures (plus duplicate rows removed by
    // the approved duplicate-rows cleaning), and monster_name is unique per
    // side post-cleaning, so the LEFT JOIN is 1-to-1: 12 anchor rows in, 12
    // result rows out, no fan-out.
    expect(stitchedRowCount).toBe(12);
    expect(fanOutAnchor).toBe(12);
    expect(fanOutResult).toBe(12);
    expect(fannedOut).toBe(false);
  });

  it("has consistent Species/species_1 on every row, and Threat_Level agrees with danger_level (item 3 + rename)", () => {
    // Both files standardize each category to the SAME Title-Case canonical,
    // so after approving every cleanup the same-meaning columns in the joined
    // result agree exactly, row by row. `species` collides case-insensitively
    // with `Species` so DuckDB suffixes it `species_1`; `danger_level` has no
    // such collision, so it keeps its name — but its standardized values still
    // match monsters\u2019 Threat_Level canonicals on the monster_name join.
    // (Rules-only this column is unmatched; the row-alignment here comes from
    // the monster_name join, not from danger_level being a join key.)
    expect(resultColumns).toContain("Species");
    expect(resultColumns).toContain("species_1");
    expect(resultColumns).toContain("Threat_Level");
    expect(resultColumns).toContain("danger_level");
    expect(resultRows).toHaveLength(12);
    for (const row of resultRows) {
      expect(String(row["Species"])).toBe(String(row["species_1"]));
      expect(String(row["Threat_Level"])).toBe(
        String(row["danger_level"]),
      );
    }
  });
});

describe("Golden example — AI DISCOVERS danger_level ↔ Threat_Level (FakeAiProvider, enhancement)", () => {
  // danger_level shares exactly one token (`level`) with monsters' Threat_Level,
  // so the rules score lands at ~0.48 (nameSim ~0.38, over the 0.2 gate, under
  // the 0.5 display threshold). Rules-only it is UNMATCHED; the AI receives it
  // as a candidate (>= AI_CANDIDATE_FLOOR) and DISCOVERS it from the shared
  // High/Medium/Low values, lifting it by the +0.3 discovery cap to ~0.78.
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;
  let discovered: MatchProposal | undefined;
  let displayedMatches: readonly MatchProposal[] = [];
  let sentDangerLevelCandidate = false;
  let stitchedRowCount = 0;
  let fannedOut = true;
  let resultRows: Record<string, unknown>[] = [];
  let resultColumns: string[] = [];

  const AI_REASON =
    "Both columns share the values High, Medium and Low, so danger_level is the same risk tier as Threat_Level.";

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
    const service = createDuckDBService(adapter);
    await service.init();

    const mismatched = await demoDataLoader.loadMismatched();
    const store = new IntakeStore();
    const intake = createIntakeController({ duckDBService: service, store });
    await intake.intake(mismatched);
    expect(store.getState().errors).toEqual([]);

    // A FakeAiProvider (no network) that DISCOVERS the Threat_Level ↔
    // danger_level match: it finds the candidate in the request by its
    // endpoints (never hardcoding the generated id), records that the pipeline
    // actually SENT it, and lifts it with a specific, value-citing reason.
    const fake = createFakeAiProvider({
      behavior: {
        kind: "fn",
        fn: (req: AiRequest): AiResponse => {
          const isDanger = (tc: { tableName: string; columnName: string }) =>
            tc.tableName === "experiments" && tc.columnName === "danger_level";
          const isThreat = (tc: { tableName: string; columnName: string }) =>
            tc.tableName === "monsters" && tc.columnName === "Threat_Level";
          const cand = req.candidates.find(
            (c) =>
              (isDanger(c.left) && isThreat(c.right)) ||
              (isThreat(c.left) && isDanger(c.right)),
          );
          if (!cand) {
            return { refinements: [] };
          }
          sentDangerLevelCandidate = true;
          return {
            refinements: [{ id: cand.id, confidence: 1, reason: AI_REASON }],
          };
        },
      },
    });

    const stitchStore = new StitchStore();
    const controller = createStitchController({
      db: service,
      getTables: () => store.getState().tables,
      store: stitchStore,
      aiProvider: fake,
      aiEnabledFlag: "true",
    });
    const proposals = await controller.computeProposals();
    displayedMatches = proposals.matches;
    discovered = findMatch(
      proposals.matches,
      { table: "monsters", column: "Threat_Level" },
      { table: "experiments", column: "danger_level" },
    );

    // Approve ALL suggestions and apply (mirrors "Approve all suggestions").
    const all: Proposal[] = [...proposals.matches, ...proposals.cleanings];
    const decisions: Record<string, ApprovalDecision> = {};
    for (const proposal of all) {
      decisions[proposal.id] = {
        proposalId: proposal.id,
        decision: "approved",
      };
    }
    const plan = assembleStitchPlan(
      proposals,
      decisions,
      store.getState().tables,
    );
    const stitched = await controller.applyPlan(plan);
    stitchedRowCount = stitched.rowCount;
    fannedOut = stitchStore.getState().fanOut!.fannedOut;
    resultColumns = stitched.schema.map((c) => c.name);
    resultRows = await service.query<Record<string, unknown>>(
      `SELECT * FROM ${stitched.tableName}`,
    );
  });

  afterAll(() => {
    dispose?.();
  });

  it("sent the sub-threshold danger_level candidate to the AI (wider floor)", () => {
    expect(sentDangerLevelCandidate).toBe(true);
  });

  it("surfaces the discovered match: source=ai, aiDiscovered, confidence in [0.5, HIGH)", () => {
    expect(discovered).toBeDefined();
    expect(discovered!.source).toBe("ai");
    expect(discovered!.aiDiscovered).toBe(true);
    expect(discovered!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(discovered!.confidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD);
    expect(discovered!.reason).toBe(AI_REASON);
  });

  it("does NOT include the discovered match in approve-all-high-confidence", () => {
    const highIds = selectHighConfidenceProposalIds(displayedMatches);
    expect(highIds.includes(discovered!.id)).toBe(false);
  });

  it("after approving all + applying: 12 rows, no fan-out, danger_level agrees with Threat_Level per row", () => {
    expect(stitchedRowCount).toBe(12);
    expect(fannedOut).toBe(false);
    expect(resultColumns).toContain("Threat_Level");
    expect(resultColumns).toContain("danger_level");
    expect(resultRows).toHaveLength(12);
    for (const row of resultRows) {
      expect(String(row["Threat_Level"])).toBe(String(row["danger_level"]));
    }
  });
});

describe("Golden example — a truly hard-gated pair is NEVER sent to the AI (safety)", () => {
  // A synthetic pair with ZERO token overlap (nameSim ~0) is hard-gated out of
  // the full scored set, so it can never be a candidate the client sends — even
  // with a maximally-eager AI. This keeps the hard-gate safety property covered.
  it("zero-token-overlap columns are gated out and never reach the provider", async () => {
    const { adapter, dispose } = await createNodeAdapter();
    try {
      const service = createDuckDBService(adapter);
      await service.init();

      // Two tiny tables whose matching-named columns share the SAME values but
      // whose column NAMES share no tokens (so only the name gate differs).
      await service.createTable(
        "alpha",
        [{ name: "qzxv", type: "string" }],
        [["High"], ["Medium"], ["Low"]],
      );
      await service.createTable(
        "beta",
        [{ name: "wmkp", type: "string" }],
        [["High"], ["Medium"], ["Low"]],
      );
      const store = new IntakeStore();
      store.addTable({
        loadId: 0,
        tableName: "alpha",
        sourceFileName: "alpha",
        schema: [{ name: "qzxv", type: "string" }],
        rowCount: 3,
      });
      store.addTable({
        loadId: 0,
        tableName: "beta",
        sourceFileName: "beta",
        schema: [{ name: "wmkp", type: "string" }],
        rowCount: 3,
      });

      let anyCandidateSent = false;
      const fake = createFakeAiProvider({
        behavior: {
          kind: "fn",
          fn: (req: AiRequest): AiResponse => {
            if (req.candidates.length > 0) {
              anyCandidateSent = true;
            }
            // Try to lift anything it is given — it must be given nothing.
            return {
              refinements: req.candidates.map((c) => ({
                id: c.id,
                confidence: 1,
                reason: "force",
              })),
            };
          },
        },
      });
      const stitchStore = new StitchStore();
      const controller = createStitchController({
        db: service,
        getTables: () => store.getState().tables,
        store: stitchStore,
        aiProvider: fake,
        aiEnabledFlag: "true",
      });
      const proposals = await controller.computeProposals();

      // The gated pair never became a candidate, so the AI saw nothing and the
      // result has no match between the two zero-overlap columns.
      expect(anyCandidateSent).toBe(false);
      expect(proposals.aiUsed).toBe(false);
      expect(proposals.matches).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});
