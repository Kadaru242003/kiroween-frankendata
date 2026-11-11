/**
 * Property-based tests for {@link createIntakeController} independent processing
 * and failure isolation.
 *
 * Feature: frankendata-file-intake, Property 10: Independent processing and
 * failure isolation
 *
 * Validates: Requirements 1.4, 9.2
 *
 * Property statement (design.md Property 10): For any set of dropped files,
 * processing each file is independent: a failure in one file does not prevent
 * the remaining files from being processed, and each file's outcome equals its
 * standalone outcome regardless of the order or presence of the other files.
 *
 * Strategy
 * --------
 * We build a generator of heterogeneous "file specs", each with a KNOWN
 * standalone outcome that is determined entirely by the file itself (not by its
 * neighbors). The four spec kinds exercise every stage that can fail before and
 * during loading, plus the success path:
 *
 *   - "success"     → a valid CSV (header + >=1 non-empty data row). Expected
 *                     outcome: a loaded table. This is the only kind that
 *                     reaches the DuckDB service.
 *   - "unsupported" → a `.txt` file. Expected outcome: an `unsupported-type`
 *                     error produced at the validation stage (before parsing).
 *   - "oversized"   → a `.csv` file whose `file.size` reports > 25 MB (we
 *                     override `size` on a small File; see `oversizedCsvFile`).
 *                     Expected outcome: an `oversized` error at validation
 *                     (before parsing), so no real bytes are read.
 *   - "empty"       → a `.csv` file with only a header row and no data rows.
 *                     Expected outcome: an `empty-file` error thrown by the real
 *                     CsvParser at the parsing stage (before loading).
 *
 * Because every failure kind fails BEFORE the DuckDB service is reached, a FAKE
 * DuckDBService whose `createTable` always succeeds is sufficient and keeps the
 * test deterministic and free of DuckDB-WASM startup cost. The fake implements
 * the full {@link DuckDBService} interface; only `createTable` is exercised.
 *
 * Each run:
 *   - generates a random-length, random-order multiset of specs (including runs
 *     where a failure precedes successes and vice versa),
 *   - uses a FRESH {@link IntakeStore} and a FRESH fake service,
 *   - runs `controller.intake(files)` exactly ONCE, then asserts:
 *       (a) nothing is dropped: tables + errors === files.length;
 *       (b) each file's outcome equals its standalone outcome: the count of each
 *           outcome kind (loaded / unsupported-type / oversized / empty-file)
 *           equals the number of specs of that kind, independent of order and of
 *           the presence of the other files;
 *       (c) failure isolation holds even when a failing file precedes a success
 *           (and vice versa) — covered by (a)+(b) over all generated orderings,
 *           and asserted directly for an all-failures-then-success arrangement.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createIntakeController } from "./intake-controller";
import { MAX_FILE_SIZE_BYTES } from "./check-size";
import type {
  CellValue,
  ColumnSchema,
  DuckDBService,
  IntakeError,
  LoadedTable,
} from "./types";
import { IntakeStore } from "../state/intake-store";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/** The distinct standalone outcomes a spec can produce. */
type Outcome =
  | { kind: "loaded" }
  | { kind: "error"; errorKind: IntakeError["kind"] };

/** A generated file spec with a known, order-independent standalone outcome. */
interface FileSpec {
  /** The File to feed to the controller. */
  readonly file: File;
  /** The outcome this file produces on its own, regardless of neighbors. */
  readonly expected: Outcome;
}

/**
 * A fake {@link DuckDBService} whose `createTable` always succeeds, returning a
 * {@link LoadedTable} derived from its inputs. Only `createTable` is reached in
 * this test (all failure specs fail before loading), so the other methods throw
 * if called to make any unexpected use obvious.
 */
function createFakeDuckDBService(): DuckDBService {
  return {
    async init(): Promise<void> {
      // No-op: nothing to initialize for the fake.
    },
    async createTable(
      tableName: string,
      schema: ColumnSchema[],
      rows: CellValue[][]
    ): Promise<LoadedTable> {
      return {
        tableName,
        // The controller overwrites sourceFileName with the real file name, so
        // the value here is irrelevant; mirror the real service's behavior.
        sourceFileName: tableName,
        schema,
        rowCount: rows.length,
      };
    },
    async getRowCount(): Promise<number> {
      throw new Error("getRowCount should not be called in this test");
    },
    async getPreviewRows(): Promise<Record<string, unknown>[]> {
      throw new Error("getPreviewRows should not be called in this test");
    },
    async query<T = Record<string, unknown>>(): Promise<T[]> {
      throw new Error("query should not be called in this test");
    },
  };
}

/** A valid CSV File: header row + one non-empty data row → loads successfully. */
function successCsvFile(name: string): File {
  const text = "a,b\n1,2";
  return new File([text], name, { type: "text/csv" });
}

/** An unsupported `.txt` File → `unsupported-type` error at validation. */
function unsupportedFile(name: string): File {
  return new File(["anything"], name, { type: "text/plain" });
}

/** A header-only CSV File (no data rows) → `empty-file` error at parsing. */
function emptyCsvFile(name: string): File {
  const text = "a,b"; // header only, zero data rows
  return new File([text], name, { type: "text/csv" });
}

/**
 * A `.csv` File that REPORTS a size greater than 25 MB without actually holding
 * that many bytes. The controller validates `file.size` via `checkSize` before
 * ever reading the bytes, so overriding the `size` getter is enough to trigger
 * the `oversized` path deterministically and cheaply.
 */
function oversizedCsvFile(name: string): File {
  const file = new File(["a,b\n1,2"], name, { type: "text/csv" });
  Object.defineProperty(file, "size", {
    value: MAX_FILE_SIZE_BYTES + 1,
    configurable: true,
  });
  return file;
}

/**
 * A spec generator. The file name's base is randomized (so table-name
 * collisions and suffixing can occur across specs) while the extension and
 * content are chosen to pin the standalone outcome.
 */
const specArb: fc.Arbitrary<FileSpec> = fc
  .record({
    kind: fc.constantFrom(
      "success" as const,
      "unsupported" as const,
      "oversized" as const,
      "empty" as const
    ),
    // A short alphanumeric base name; the extension is appended per kind.
    base: fc
      .string({
        unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
        minLength: 1,
        maxLength: 6,
      })
      .filter((s) => s.length > 0),
  })
  .map(({ kind, base }): FileSpec => {
    switch (kind) {
      case "success":
        return {
          file: successCsvFile(`${base}.csv`),
          expected: { kind: "loaded" },
        };
      case "unsupported":
        return {
          file: unsupportedFile(`${base}.txt`),
          expected: { kind: "error", errorKind: "unsupported-type" },
        };
      case "oversized":
        return {
          file: oversizedCsvFile(`${base}.csv`),
          expected: { kind: "error", errorKind: "oversized" },
        };
      case "empty":
        return {
          file: emptyCsvFile(`${base}.csv`),
          expected: { kind: "error", errorKind: "empty-file" },
        };
    }
  });

/** Count expected outcomes of each kind across a set of specs. */
function expectedCounts(specs: FileSpec[]): {
  loaded: number;
  errorsByKind: Map<IntakeError["kind"], number>;
} {
  let loaded = 0;
  const errorsByKind = new Map<IntakeError["kind"], number>();
  for (const spec of specs) {
    if (spec.expected.kind === "loaded") {
      loaded += 1;
    } else {
      const k = spec.expected.errorKind;
      errorsByKind.set(k, (errorsByKind.get(k) ?? 0) + 1);
    }
  }
  return { loaded, errorsByKind };
}

describe("IntakeController — Property 10: Independent processing and failure isolation", () => {
  it("processes every file independently; each outcome equals its standalone outcome regardless of order or neighbors", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A random-length multiset of specs in random order. minLength 1 keeps
        // the batch non-trivial; the mix of kinds places failures before and
        // after successes across the many generated orderings.
        fc.array(specArb, { minLength: 1, maxLength: 10 }),
        async (specs) => {
          const store = new IntakeStore();
          const controller = createIntakeController({
            duckDBService: createFakeDuckDBService(),
            store,
          });

          await controller.intake(specs.map((s) => s.file));

          const { tables, errors } = store.getState();

          // (a) Nothing is dropped: every file produced exactly one outcome.
          expect(tables.length + errors.length).toBe(specs.length);

          // (b) Each file's outcome equals its standalone outcome: the count of
          //     each outcome kind matches the number of specs producing it,
          //     independent of order/neighbors.
          const expected = expectedCounts(specs);

          expect(tables.length).toBe(expected.loaded);

          const actualErrorsByKind = new Map<IntakeError["kind"], number>();
          for (const err of errors) {
            actualErrorsByKind.set(
              err.kind,
              (actualErrorsByKind.get(err.kind) ?? 0) + 1
            );
          }

          // Both the set of error kinds and each kind's count must match.
          const allKinds = new Set<IntakeError["kind"]>([
            ...expected.errorsByKind.keys(),
            ...actualErrorsByKind.keys(),
          ]);
          for (const kind of allKinds) {
            expect(actualErrorsByKind.get(kind) ?? 0).toBe(
              expected.errorsByKind.get(kind) ?? 0
            );
          }

          // Every recorded error names a file that was actually dropped (the
          // outcome is attributed to the right file, not a neighbor).
          const droppedNames = new Set(specs.map((s) => s.file.name));
          for (const err of errors) {
            expect(droppedNames.has(err.sourceFileName)).toBe(true);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("a failing file preceding successes does not prevent the later successes from loading", async () => {
    // Directly exercise the "failure precedes success" arrangement: three
    // failures of different kinds up front, then two successes. All five
    // outcomes must be recorded with no success dropped.
    const store = new IntakeStore();
    const controller = createIntakeController({
      duckDBService: createFakeDuckDBService(),
      store,
    });

    const files = [
      unsupportedFile("first.txt"),
      oversizedCsvFile("second.csv"),
      emptyCsvFile("third.csv"),
      successCsvFile("fourth.csv"),
      successCsvFile("fifth.csv"),
    ];

    await controller.intake(files);

    const { tables, errors } = store.getState();

    // Both trailing successes loaded despite three leading failures (Req 1.4, 9.2).
    expect(tables.length).toBe(2);
    expect(errors.length).toBe(3);

    const errorKinds = errors.map((e) => e.kind).sort();
    expect(errorKinds).toEqual(
      ["empty-file", "oversized", "unsupported-type"].sort()
    );
    const loadedNames = tables.map((t) => t.sourceFileName).sort();
    expect(loadedNames).toEqual(["fifth.csv", "fourth.csv"]);
  });

  it("a success preceding failures still loads, and later failures are isolated", async () => {
    // The reverse arrangement: a success first, then failures. The success must
    // load and each later failure is recorded independently.
    const store = new IntakeStore();
    const controller = createIntakeController({
      duckDBService: createFakeDuckDBService(),
      store,
    });

    const files = [
      successCsvFile("alpha.csv"),
      unsupportedFile("beta.txt"),
      emptyCsvFile("gamma.csv"),
    ];

    await controller.intake(files);

    const { tables, errors } = store.getState();

    expect(tables.length).toBe(1);
    expect(tables[0].sourceFileName).toBe("alpha.csv");
    expect(errors.length).toBe(2);
    expect(errors.map((e) => e.kind).sort()).toEqual(
      ["empty-file", "unsupported-type"].sort()
    );
  });
});
