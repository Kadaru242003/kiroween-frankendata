/**
 * Property-based test for {@link createIntakeController} accepting every file.
 *
 * Feature: frankendata-file-intake, Property 8: Accept all dropped files
 *
 * Validates: Requirements 1.2
 *
 * Property statement (design.md Property 8): For any number of dropped files,
 * every dropped file is accepted for processing regardless of the count. The
 * "2–4 files is the intended range" guidance is a UI concern and is NOT
 * enforced by the controller, so counts of 0, 1, and 5+ are all accepted and
 * each file produces exactly one outcome.
 *
 * ## Stub approach
 *
 * This property is about count and completeness ("every file is processed"),
 * not about DuckDB-backed table creation (covered by the 10.x properties). To
 * keep the test fast and deterministic we inject a FAKE DuckDBService that
 * implements the {@link DuckDBService} interface from `./types`:
 *
 *  - `createTable` records each call (so we can assert every valid file reached
 *    the loading stage exactly once) and returns a trivial {@link LoadedTable}
 *    synchronously — no WASM instance, no SQL, no row insertion.
 *  - `init` / `getRowCount` / `getPreviewRows` / `query` are present to satisfy
 *    the interface but are unused by the `intake` path.
 *
 * A fresh {@link IntakeStore} is created per run so outcomes (tables + errors)
 * can be counted in isolation. Because the controller processes each file
 * independently and publishes exactly one outcome per file (a LoadedTable on
 * success, an IntakeError on failure), the invariant checked here is:
 *
 *     tables.length + errors.length === files.length    (for ANY count)
 *
 * We also include a mix where some files have an unsupported extension to show
 * they are still "accepted for processing" and produce an outcome (an error) —
 * never silently dropped — while valid CSV files each trigger exactly one
 * createTable call.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createIntakeController } from "./intake-controller";
import { IntakeStore } from "../state/intake-store";
import type {
  CellValue,
  ColumnSchema,
  DuckDBService,
  LoadedTable,
} from "./types";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/**
 * A fake {@link DuckDBService} that records `createTable` calls and returns a
 * trivial table without touching DuckDB-WASM. Only `createTable` is exercised
 * by the controller's success path; the remaining methods exist to satisfy the
 * interface and throw if ever called so an accidental dependency is loud.
 */
class RecordingDuckDBService implements DuckDBService {
  readonly createTableCalls: string[] = [];

  async init(): Promise<void> {
    // No-op: the fake holds no state to initialize.
  }

  async createTable(
    tableName: string,
    schema: ColumnSchema[],
    rows: CellValue[][]
  ): Promise<LoadedTable> {
    this.createTableCalls.push(tableName);
    return {
      tableName,
      // The controller overwrites sourceFileName with the real file name, so
      // the value here is irrelevant to the assertions.
      sourceFileName: tableName,
      schema,
      rowCount: rows.length,
    };
  }

  async getRowCount(): Promise<number> {
    throw new Error("getRowCount is not used by Property 8");
  }

  async getPreviewRows(): Promise<Record<string, unknown>[]> {
    throw new Error("getPreviewRows is not used by Property 8");
  }

  async query<T = Record<string, unknown>>(): Promise<T[]> {
    throw new Error("query is not used by Property 8");
  }
}

/**
 * A generated file spec: whether it should be a valid CSV (accepted + loaded)
 * or an unsupported-extension file (accepted but recorded as an error). Both
 * kinds are "accepted for processing" and each yields exactly one outcome.
 */
interface FileSpec {
  valid: boolean;
}

const fileSpecArb: fc.Arbitrary<FileSpec> = fc.record({
  valid: fc.boolean(),
});

/**
 * An arbitrary-length list of file specs (0..20) to exercise counts below,
 * inside, and well above the UI's 2–4 guidance range — including the empty,
 * single-file, and 5+-file cases the controller must still accept.
 */
const fileSpecsArb: fc.Arbitrary<FileSpec[]> = fc.array(fileSpecArb, {
  minLength: 0,
  maxLength: 20,
});

/** A minimal, valid CSV body with one header row and one data row. */
const VALID_CSV = "a,b\n1,2";

/** Build a File for a spec: a valid `.csv` or an unsupported `.bin`. */
function buildFile(spec: FileSpec, index: number): File {
  if (spec.valid) {
    return new File([VALID_CSV], `valid_${index}.csv`, { type: "text/csv" });
  }
  // Unsupported extension — accepted for processing but detected as an error.
  return new File(["anything"], `other_${index}.bin`, {
    type: "application/octet-stream",
  });
}

describe("IntakeController — Property 8: Accept all dropped files", () => {
  it("produces exactly one outcome per dropped file for any count", async () => {
    await fc.assert(
      fc.asyncProperty(fileSpecsArb, async (specs) => {
        // Fresh store + fake service per run so outcomes can be counted in
        // isolation (Req 1.2).
        const store = new IntakeStore();
        const duckDBService = new RecordingDuckDBService();
        const controller = createIntakeController({ duckDBService, store });

        const files = specs.map((spec, index) => buildFile(spec, index));
        const expectedValidCount = specs.filter((s) => s.valid).length;

        await controller.intake(files);

        const { tables, errors } = store.getState();

        // Every file is accepted for processing: total outcomes equal the file
        // count for ANY count (0, 1, 2–4, and 5+ alike). No file is silently
        // dropped.
        expect(tables.length + errors.length).toBe(files.length);

        // Every valid CSV reached the loading stage exactly once (one
        // createTable call per valid file), proving acceptance is not merely a
        // recorded outcome but actual processing.
        expect(duckDBService.createTableCalls.length).toBe(expectedValidCount);
        expect(tables.length).toBe(expectedValidCount);

        // The unsupported-extension files are accepted-but-errored, never
        // dropped: their count accounts for the remaining outcomes.
        expect(errors.length).toBe(files.length - expectedValidCount);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
