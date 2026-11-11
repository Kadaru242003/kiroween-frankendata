/**
 * Property-based test for {@link createIntakeController} load-failure reporting.
 *
 * Feature: frankendata-file-intake, Property 27: Load failure error names the file
 *
 * Validates: Requirements 6.8, 9.1
 *
 * Property statement (design.md Property 27): For any file that fails to parse,
 * type-infer, or load for reasons other than the string-fallback case, the
 * recorded error names that file and describes the failure.
 *
 * Contract (confirmed against `intake-controller.ts`):
 *  - A failing file is processed inside its own try/catch and records exactly
 *    one `IntakeError` in the store (Req 9.1, 9.2); the controller never throws
 *    for a per-file failure.
 *  - The error's `sourceFileName` carries the ORIGINAL `file.name` verbatim.
 *    Table-name sanitization applies to the DuckDB table name, NOT to the
 *    error's `sourceFileName`, so varied names (spaces / unicode) must survive
 *    unchanged.
 *  - Loading failures: when the injected `DuckDBService.createTable` rejects,
 *    the controller records the failure at the `loading` stage as
 *    `table-load-failed` (either the embedded `IntakeError` of a thrown
 *    `IntakeFailure`, or a wrapped generic throw via `unexpectedError`, whose
 *    message contains the file name and "could not be loaded"). Req 6.8.
 *  - Parse / validation failures (empty-file, unsupported-type, oversized)
 *    reach the same recording path; each names the file and describes the
 *    failure. Req 9.1.
 *
 * The invariant asserted for EVERY generated failing file is the heart of this
 * property: exactly one `IntakeError` is recorded whose `sourceFileName` equals
 * the original `file.name` and whose `message` is a non-empty description.
 *
 * A FAKE/STUB `DuckDBService` is used to deterministically force loading
 * failures, and a FRESH `IntakeStore` is used per run so counts are exact.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createIntakeController } from "./intake-controller";
import { IntakeFailure } from "./intake-failure";
import { MAX_FILE_SIZE_BYTES } from "./check-size";
import { IntakeStore } from "../state/intake-store";
import type { DuckDBService, IntakeError } from "./types";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/**
 * Arbitrary file BASE names, intentionally varied — spaces, unicode, symbols,
 * and leading digits — so we confirm the ORIGINAL name is carried verbatim into
 * `IntakeError.sourceFileName` regardless of table-name sanitization. We avoid
 * path separators and the dot so a chosen extension stays unambiguous.
 */
const baseNameArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom(
      ..."abcXYZ0123 _-#@!é漢字αΩ".split("")
    ),
    minLength: 1,
    maxLength: 20,
  })
  .filter((s) => !s.includes("/") && !s.includes("\\") && !s.includes("."))
  .filter((s) => s.length > 0);

/** A never-used DuckDB method stub: createTable is the only path exercised. */
function unusedMethod(): never {
  throw new Error("unexpected DuckDBService call in load-failure test");
}

/**
 * Build a stub {@link DuckDBService} whose `createTable` rejects. The thrown
 * value is parameterized so we cover both surfacing paths:
 *  - a structured `IntakeFailure` (kind `table-load-failed`, stage `loading`),
 *  - a generic `Error` the controller wraps into `table-load-failed`.
 */
function failingDuckDB(
  makeRejection: (sourceFileName: string) => unknown
): DuckDBService {
  return {
    init: async () => {},
    createTable: async (tableName) => {
      // `tableName` is sanitized, but the rejection names the real file via the
      // controller's own wrapping; for the IntakeFailure case the caller bakes
      // the original file name into the rejection it supplies below.
      void tableName;
      throw makeRejection(tableName);
    },
    getRowCount: unusedMethod,
    getPreviewRows: unusedMethod,
    query: unusedMethod,
  };
}

/** A minimal VALID CSV so processing reaches the loading stage. */
function validCsvFile(name: string): File {
  return new File(["a,b\n1,2\n"], name, { type: "text/csv" });
}

/**
 * Assert the shared Property-27 invariant for a single failing file: the store
 * holds exactly one error, no tables, and the error names the file with a
 * non-empty descriptive message.
 */
function expectSingleNamedError(
  store: IntakeStore,
  fileName: string
): IntakeError {
  const { tables, errors } = store.getState();
  expect(tables).toHaveLength(0);
  expect(errors).toHaveLength(1);
  const error = errors[0];
  // Names the file verbatim (Req 6.8, 9.1).
  expect(error.sourceFileName).toBe(fileName);
  // Describes the failure — a non-empty message.
  expect(error.message.length).toBeGreaterThan(0);
  return error;
}

describe("IntakeController — Property 27: Load failure error names the file", () => {
  it("records a table-load-failed error naming the file when createTable rejects with an IntakeFailure", async () => {
    await fc.assert(
      fc.asyncProperty(baseNameArb, async (base) => {
        const fileName = `${base}.csv`;
        const store = new IntakeStore();
        const controller = createIntakeController({
          store,
          duckDBService: failingDuckDB((_tableName) => {
            // Parser-style structured failure that already names the real file.
            return new IntakeFailure({
              sourceFileName: fileName,
              stage: "loading",
              kind: "table-load-failed",
              message: `The file "${fileName}" could not be loaded into a table.`,
            });
          }),
        });

        await controller.intake([validCsvFile(fileName)]);

        const error = expectSingleNamedError(store, fileName);
        expect(error.kind).toBe("table-load-failed");
        expect(error.stage).toBe("loading");
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("wraps a generic createTable throw into a table-load-failed error naming the file", async () => {
    await fc.assert(
      fc.asyncProperty(
        baseNameArb,
        fc.string({ minLength: 1, maxLength: 24 }),
        async (base, reason) => {
          const fileName = `${base}.csv`;
          const store = new IntakeStore();
          const controller = createIntakeController({
            store,
            // A plain Error (NOT an IntakeFailure) must still be surfaced,
            // named, and non-blocking (Req 9.1/9.2) via the controller's wrap.
            duckDBService: failingDuckDB(() => new Error(reason)),
          });

          await controller.intake([validCsvFile(fileName)]);

          const error = expectSingleNamedError(store, fileName);
          expect(error.kind).toBe("table-load-failed");
          expect(error.stage).toBe("loading");
          // The wrapped message names the file and describes the failure.
          expect(error.message).toContain(fileName);
          expect(error.message).toContain("could not be loaded");
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("names the file for a non-Error throw (e.g. a string) from createTable", async () => {
    await fc.assert(
      fc.asyncProperty(
        baseNameArb,
        fc.string({ minLength: 1, maxLength: 24 }),
        async (base, reason) => {
          const fileName = `${base}.csv`;
          const store = new IntakeStore();
          const controller = createIntakeController({
            store,
            duckDBService: failingDuckDB(() => reason),
          });

          await controller.intake([validCsvFile(fileName)]);

          const error = expectSingleNamedError(store, fileName);
          expect(error.kind).toBe("table-load-failed");
          expect(error.stage).toBe("loading");
          expect(error.message).toContain(fileName);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("names the file for parse / validation failures routed through the real pipeline", async () => {
    // Additional coverage across OTHER failure stages. The DuckDB stub must
    // never be reached because each file fails before loading; if it is, the
    // stub throws and the test surfaces the mistake.
    const neverLoadDuckDB: DuckDBService = failingDuckDB(() => {
      throw new Error("createTable should not run for pre-loading failures");
    });

    // A generator producing a failing file plus the error kind we expect.
    const failingFileArb = fc.oneof(
      // empty-file: valid .csv extension, but zero data rows (Req 3.2 / 9.1).
      baseNameArb.map((base) => ({
        file: new File([""], `${base}.csv`, { type: "text/csv" }),
        fileName: `${base}.csv`,
        expectedKind: "empty-file" as const,
      })),
      // unsupported-type: an extension the pipeline rejects (Req 2.2 / 9.1).
      baseNameArb.map((base) => ({
        file: new File(["anything"], `${base}.txt`, { type: "text/plain" }),
        fileName: `${base}.txt`,
        expectedKind: "unsupported-type" as const,
      })),
      // oversized: a .csv just over the size limit (Req 2.3 / 9.1).
      baseNameArb.map((base) => {
        const name = `${base}.csv`;
        const file = new File(["a,b\n1,2\n"], name, { type: "text/csv" });
        // Force the reported size past the limit without allocating real bytes.
        Object.defineProperty(file, "size", {
          value: MAX_FILE_SIZE_BYTES + 1,
          configurable: true,
        });
        return { file, fileName: name, expectedKind: "oversized" as const };
      })
    );

    await fc.assert(
      fc.asyncProperty(failingFileArb, async ({ file, fileName, expectedKind }) => {
        const store = new IntakeStore();
        const controller = createIntakeController({
          store,
          duckDBService: neverLoadDuckDB,
        });

        await controller.intake([file]);

        const error = expectSingleNamedError(store, fileName);
        // The error describes the failure via the expected kind, and the
        // message names the file (the heart of Req 9.1).
        expect(error.kind).toBe(expectedKind);
        expect(error.message).toContain(fileName);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
