/**
 * Property-based tests for cleaning idempotence.
 *
 * Feature: frankendata-ai-stitching, Property 4: Cleaning idempotence
 *
 * Validates: Requirements 2.8, 10.3
 *
 * Property 4 statement (design, "Correctness Properties"): *For any*
 * `CleaningProposal`, applying it twice in succession to already-cleaned data
 * yields the same result as applying it once — i.e. `clean(clean(x)) ==
 * clean(x)`. The design's "Cleaning rules" section promises every transform is
 * "idempotent by construction": whitespace folding stabilizes on trimmed/
 * collapsed text, case and category standardization map each surface form to a
 * canonical that is itself a fixed point of the map, and the SQL cleaned-copy
 * apply composes those same transforms (whitespace → case → category) per
 * column.
 *
 * This test proves idempotence at two complementary levels, both with ≥100
 * fast-check iterations:
 *
 *  1. **Pure level (no DuckDB, the headline check).** From a generated text
 *     column we run the real {@link cleanTables} engine, derive the exact
 *     value→value transform each emitted proposal represents (whitespace via
 *     {@link normalizeWhitespace}; case/category via {@link variantMap}
 *     application), compose them in the applier's fixed order, and assert that
 *     transforming an already-transformed value is a no-op for every value in
 *     the column's domain. We also pin the primitive invariants the whole
 *     construction rests on: `normalizeWhitespace`/`foldCategory` are fixed on
 *     their own output, and every `variantMap` canonical maps to itself.
 *
 *  2. **DuckDB-backed level.** We materialize a generated table, run the real
 *     SQL cleaned-copy apply ({@link applyCleanedCopy}) to produce a cleaned
 *     copy, then run the *same* transform again treating the cleaned copy as a
 *     fresh source, and assert the twice-cleaned copy is row-for-row identical
 *     to the once-cleaned copy. A FRESH in-memory DuckDB instance is created per
 *     test (the node-blocking MVP bundle can wedge otherwise), matching the
 *     pattern in `stitch-applier.duckdb.test.ts` / `cleaning-rules.duckdb.test.ts`.
 *
 * Functions under test:
 *   - {@link cleanTables} and the pure helpers {@link normalizeWhitespace},
 *     {@link foldCategory} (task 7);
 *   - {@link applyCleanedCopy} / {@link groupApprovedForTable} (task 8.1).
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ColumnSchema } from "../types";
import {
  createDuckDBService,
  type DuckDBConnectionAdapter,
} from "../../db/duckdb-service";
import {
  cleanTables,
  foldCategory,
  normalizeWhitespace,
} from "./cleaning-rules";
import {
  applyCleanedCopy,
  groupApprovedForTable,
} from "./stitch-applier";
import type {
  CleaningProposal,
  SampleValue,
  TableSample,
} from "./types";

/** Property-test iteration count (design: fast-check, ≥ 100 iterations). */
const NUM_RUNS = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Shared generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A small, deliberately messy vocabulary of category-ish values that overlap
 * under whitespace/case/punctuation folding, so generated columns frequently
 * yield real whitespace / case / category-standardize proposals (the whole
 * point — an idempotence claim about transforms is vacuous if no transform is
 * ever produced). Includes leading/trailing and internal extra whitespace,
 * differing casings of the same word, and punctuation variants.
 */
const messyValue = fc.constantFrom(
  "Swamp Wraith",
  "swamp wraith",
  "swamp-wraith",
  "  swamp   wraith ",
  "SWAMP_WRAITH",
  "Bog Golem",
  "bog golem",
  "bog  golem",
  "Night Howler",
  "night-howler",
  " night howler ",
  "Ogre",
  "ogre",
  "  Ogre  ",
);

/** The full messy vocabulary, used to exercise each transform over all inputs. */
const VOCABULARY: readonly string[] = [
  "Swamp Wraith",
  "swamp wraith",
  "swamp-wraith",
  "  swamp   wraith ",
  "SWAMP_WRAITH",
  "Bog Golem",
  "bog golem",
  "bog  golem",
  "Night Howler",
  "night-howler",
  " night howler ",
  "Ogre",
  "ogre",
  "  Ogre  ",
];

/** A frequency-carrying sample list over the messy vocabulary (never empty). */
const messySamples: fc.Arbitrary<SampleValue[]> = fc.array(
  fc.record({
    value: messyValue as fc.Arbitrary<string | null>,
    count: fc.integer({ min: 1, max: 20 }),
  }),
  { minLength: 1, maxLength: 12 },
);

/** A single-column text {@link TableSample} built from generated samples. */
function stringColumnTable(
  tableName: string,
  columnName: string,
  samples: SampleValue[]
): TableSample {
  return {
    tableName,
    rowCount: 0,
    schema: [{ name: columnName, type: "string" }],
    samplesByColumn: { [columnName]: samples },
  };
}

/**
 * A DuckDBService stub whose COUNT queries report zero rows/dups/outliers, so
 * the *pure* whitespace/case/category proposals are produced without any real
 * SQL (duplicate-rows and outliers — which need full-column SQL — are covered
 * by their own DuckDB-backed tests and the DuckDB section below).
 */
function zeroDb() {
  return {
    init: async () => {},
    createTable: async () => {},
    getRowCount: async () => 0,
    getPreviewRows: async () => [],
    query: async () => [{ total: 0, dups: 0, non_null: 0, outliers: 0 }],
  } as unknown as Parameters<typeof cleanTables>[0];
}

/**
 * Apply a {@link CleaningProposal} to a single scalar value, mirroring EXACTLY
 * what the SQL cleaned-copy apply does per column (`columnSelectExpr` in
 * `stitch-applier.ts`): a whitespace proposal (no `variantMap`) trims+collapses;
 * a case/category proposal (with a `variantMap`) maps a matched variant to its
 * canonical, leaving unmatched values unchanged.
 */
function applyProposalToValue(value: string, proposal: CleaningProposal): string {
  if (proposal.kind === "whitespace-case" && !proposal.variantMap) {
    return normalizeWhitespace(value);
  }
  const map = proposal.variantMap;
  if (map) {
    return map[value] ?? value;
  }
  return value;
}

/**
 * Compose every column-level proposal into a single value→value transform in
 * the applier's fixed order (whitespace → case → category). Returns the derived
 * transform plus the ordered proposals it was built from.
 */
function deriveColumnTransform(
  proposals: CleaningProposal[]
): (value: string) => string {
  const whitespace = proposals.filter(
    (p) => p.kind === "whitespace-case" && !p.variantMap
  );
  const caseProposals = proposals.filter(
    (p) => p.kind === "whitespace-case" && p.variantMap
  );
  const category = proposals.filter((p) => p.kind === "category-standardize");
  const ordered = [...whitespace, ...caseProposals, ...category];
  return (value: string) =>
    ordered.reduce((acc, p) => applyProposalToValue(acc, p), value);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure-level idempotence (no DuckDB) — the headline Property 4 check
// ─────────────────────────────────────────────────────────────────────────────

describe("Property 4: Cleaning idempotence — pure primitives (Req 2.8, 10.3)", () => {
  it("normalizeWhitespace is a fixed point on its own output: f(f(x)) === f(x)", () => {
    fc.assert(
      fc.property(messyValue, (value) => {
        const once = normalizeWhitespace(value);
        expect(normalizeWhitespace(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("foldCategory is a fixed point on its own output: f(f(x)) === f(x)", () => {
    fc.assert(
      fc.property(messyValue, (value) => {
        const once = foldCategory(value);
        expect(foldCategory(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});

describe("Property 4: Cleaning idempotence — derived transforms (Req 2.8, 10.3)", () => {
  it("every emitted variantMap canonical is a fixed point (canonical ↦ canonical)", async () => {
    await fc.assert(
      fc.asyncProperty(messySamples, async (samples) => {
        const proposals = await cleanTables(
          zeroDb(),
          [stringColumnTable("t", "kind", samples)]
        );
        for (const proposal of proposals) {
          const map = proposal.variantMap;
          if (!map) {
            continue;
          }
          for (const canonical of Object.values(map)) {
            // The canonical must appear in the map and map to itself, so a
            // second application of the map is a no-op (resurrection-free).
            expect(map[canonical] ?? canonical).toBe(canonical);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("the composed per-column transform satisfies clean(clean(x)) === clean(x) for every value in the column", async () => {
    await fc.assert(
      fc.asyncProperty(messySamples, async (samples) => {
        const proposals = await cleanTables(
          zeroDb(),
          [stringColumnTable("t", "kind", samples)]
        );
        const transform = deriveColumnTransform(proposals);
        // The column's value domain = the distinct generated surface forms.
        const domain = [...new Set(samples.map((s) => s.value as string))];
        for (const value of domain) {
          const once = transform(value);
          const twice = transform(once);
          expect(twice).toBe(once);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("each individual proposal, applied alone, is idempotent across the whole vocabulary", async () => {
    await fc.assert(
      fc.asyncProperty(messySamples, async (samples) => {
        const proposals = await cleanTables(
          zeroDb(),
          [stringColumnTable("t", "kind", samples)]
        );
        for (const proposal of proposals) {
          for (const value of VOCABULARY) {
            const once = applyProposalToValue(value, proposal);
            const twice = applyProposalToValue(once, proposal);
            expect(twice).toBe(once);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DuckDB-backed idempotence of the real SQL cleaned-copy apply
// ─────────────────────────────────────────────────────────────────────────────
//
// DuckDB-WASM's browser bundles need a real worker environment unavailable
// under jsdom, so we wrap the node-blocking MVP bundle in a
// DuckDBConnectionAdapter and inject it via createDuckDBService — identical to
// the pattern in stitch-applier.duckdb.test.ts. A FRESH instance is created per
// test so a wedged MVP connection never leaks between cases.

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs") as {
  createDuckDB: (
    bundles: unknown,
    logger: unknown,
    runtime: unknown
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
  require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs")
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
    duckdb.NODE_RUNTIME
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

describe("Property 4: Cleaning idempotence — real SQL cleaned-copy apply (Req 2.8, 10.3)", () => {
  let adapter: DuckDBConnectionAdapter;
  let dispose: () => void;

  beforeAll(async () => {
    ({ adapter, dispose } = await createNodeAdapter());
  });

  afterAll(() => {
    dispose?.();
  });

  let serial = 0;
  const schema: ColumnSchema[] = [{ name: "kind", type: "string" }];

  it("applying the cleaned-copy transform to an already-cleaned copy changes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(messyValue, { minLength: 1, maxLength: 12 }),
        async (values) => {
          serial += 1;
          const service = createDuckDBService(adapter);
          await service.init();

          const src = `idem_src_${serial}`;
          await service.createTable(
            src,
            schema,
            values.map((v) => [v])
          );

          // Build the real proposals the engine would emit for this column,
          // then group them into the applier's ApprovedCleaning shape.
          const reader: TableSample = {
            tableName: src,
            rowCount: values.length,
            schema,
            samplesByColumn: {
              kind: distinctSamples(values),
            },
          };
          const proposals = await cleanTables(service, [reader]);
          const columnProposals = proposals.filter(
            (p) =>
              p.target.columnName === "kind" &&
              (p.kind === "whitespace-case" ||
                p.kind === "category-standardize")
          );
          // No column-level cleaning proposal → nothing to assert for this
          // sample; the transform is trivially the identity. Skip cleanly.
          if (columnProposals.length === 0) {
            return;
          }
          const approved = groupApprovedForTable(schema, columnProposals);

          // First apply: clean the original into a cleaned copy.
          const copy1 = await applyCleanedCopy(
            service,
            serial,
            src,
            schema,
            approved
          );
          const after1 = await readKinds(service, copy1);

          // Second apply: treat the cleaned copy as a fresh source and run the
          // SAME transform again. The proposals' variantMaps/whitespace are
          // keyed by the original surface forms; applied to already-cleaned
          // values they must be a no-op (idempotence by construction).
          const copy2 = await applyCleanedCopy(
            service,
            serial + 100000,
            copy1,
            schema,
            approved
          );
          const after2 = await readKinds(service, copy2);

          expect(after2).toEqual(after1);
        }
      ),
      { numRuns: NUM_RUNS }
    );
    // Explicit generous timeout: this runs NUM_RUNS (≥100) iterations of real
    // DuckDB-WASM SQL (two cleaned-copy applies + reads each). It comfortably
    // fits well under this bound when files run serially, but the default 5s
    // testTimeout is too tight for a DuckDB-backed property loop, so pin it.
  }, 120_000);
});

/** Read the `kind` column of a table as a sorted string array for comparison. */
async function readKinds(
  service: ReturnType<typeof createDuckDBService>,
  table: string
): Promise<string[]> {
  const rows = await service.query<{ kind: string }>(
    `SELECT kind FROM "${table.replace(/"/g, '""')}" ORDER BY kind`
  );
  return rows.map((r) => r.kind);
}

/** Distinct (value, count) samples from a raw value list, highest count first. */
function distinctSamples(values: string[]): SampleValue[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.value < b.value ? -1 : 1
    );
}
