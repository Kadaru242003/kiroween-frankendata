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
import { HIGH_CONFIDENCE_THRESHOLD } from "./types";
import type { MatchProposal, ProposalSet } from "./types";

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

  it("surfaces the threat pair monsters.\"Threat Level\" ↔ experiments.threat_level above threshold (Req 1.2)", () => {
    const match = findMatch(
      matches,
      { table: "monsters", column: "Threat_Level" },
      { table: "experiments", column: "threat_level" },
    );
    expect(match).toBeDefined();
    expect(match!.confidence).toBeGreaterThan(0.5);
    expect(match!.source).toBe("rules");
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
