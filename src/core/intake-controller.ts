/**
 * Intake orchestration for the FrankenData file-intake pipeline (task 12.1).
 *
 * `createIntakeController` returns an implementation of the
 * {@link IntakeController} interface. Its single method, `intake`, runs the
 * per-file pipeline for every provided file:
 *
 *   detectType → size check → parser → TypeInferenceLayer → NameSanitizer →
 *   DuckDBService
 *
 * publishing each outcome (a {@link LoadedTable} or an {@link IntakeError}) to
 * the injected {@link IntakeStore}.
 *
 * ## Failure isolation (Req 1.4, 9.2)
 *
 * Every file is processed inside its own `try/catch`, so a failure in one file
 * never halts the remaining files. A file that fails at any stage records an
 * {@link IntakeError} (naming the file and describing the failure) and
 * processing continues with the next file. The controller never throws from
 * `intake` for a per-file failure.
 *
 * ## Accept every dropped file (Req 1.2)
 *
 * The controller accepts and processes every file regardless of the count. The
 * "2–4 files is the intended range" guidance is a UI concern (DropZone) and is
 * deliberately NOT enforced here.
 *
 * ## Shared pipeline (Req 13.2)
 *
 * The same controller is used for dropped files and demo datasets; the
 * DemoDataLoader produces `File` objects and routes them through `intake`.
 *
 * ## Dependency injection
 *
 * The controller is built around injectable collaborators so it is testable and
 * so the DuckDB service can be swapped between the browser bundle (app) and the
 * node-blocking bundle (tests). Only `duckDBService` and `store` are required;
 * parsers, the type-inference layer, and the name sanitizer default to the real
 * shared modules.
 */

import { CsvParser } from "./csv-parser";
import { XlsxParser } from "./xlsx-parser";
import { detectType } from "./detect-type";
import { checkSize } from "./check-size";
import { isIntakeFailure } from "./intake-failure";
import { nameSanitizer as defaultNameSanitizer } from "./name-sanitizer";
import { typeInferenceLayer as defaultTypeInference } from "./type-inference";
import type {
  ColumnSchema,
  DuckDBService,
  FileParser,
  FileType,
  IntakeController,
  IntakeError,
  NameSanitizer,
  ParsedFile,
  TypeInferenceLayer,
} from "./types";
import type { IntakeStore } from "../state/intake-store";

/** Parsers keyed by the supported {@link FileType}s. */
export interface IntakeParsers {
  csv: FileParser;
  xlsx: FileParser;
}

/** Dependencies for {@link createIntakeController}. */
export interface IntakeControllerDeps {
  /** The DuckDB service used to create typed tables (injectable per environment). */
  duckDBService: DuckDBService;
  /** The session store that receives loaded tables and errors. */
  store: IntakeStore;
  /** Optional parser overrides; defaults to the real CSV/XLSX parsers. */
  parsers?: Partial<IntakeParsers>;
  /** Optional type-inference layer; defaults to the shared instance. */
  typeInference?: TypeInferenceLayer;
  /** Optional name sanitizer; defaults to the shared instance. */
  sanitizer?: NameSanitizer;
}

/**
 * Create an {@link IntakeController} from the given dependencies.
 *
 * `parsers`, `typeInference`, and `sanitizer` default to the real shared
 * modules; `duckDBService` and `store` must be provided so the controller can
 * be wired to the right DuckDB bundle and session store.
 */
export function createIntakeController(
  deps: IntakeControllerDeps
): IntakeController {
  const { duckDBService, store } = deps;
  const typeInference = deps.typeInference ?? defaultTypeInference;
  const sanitizer = deps.sanitizer ?? defaultNameSanitizer;
  const parsers: IntakeParsers = {
    csv: deps.parsers?.csv ?? new CsvParser(),
    xlsx: deps.parsers?.xlsx ?? new XlsxParser(),
  };

  return {
    async intake(files: File[]): Promise<void> {
      // Accumulate the table names assigned so far so later files that would
      // collide receive a unique numeric suffix (Req 6.3). This spans the whole
      // intake call, which is why sanitization happens here rather than per file
      // in isolation.
      const existingTableNames: string[] = [];

      // Process files sequentially. Each file's pipeline is isolated in its own
      // try/catch so one failure never stops the others (Req 1.4, 9.2). Order is
      // preserved so table-name suffixes are deterministic.
      for (const file of files) {
        await processFile(file);
      }

      /** Run the full pipeline for a single file, recording its outcome. */
      async function processFile(file: File): Promise<void> {
        const sourceFileName = file.name;
        try {
          // 1. Type detection from extension (Req 2.1, 2.2).
          const fileType: FileType = detectType(sourceFileName);
          if (fileType === "unsupported") {
            store.addError(unsupportedTypeError(sourceFileName));
            return;
          }

          // 2. Size guard (Req 2.3). checkSize returns an oversized IntakeError
          //    or null.
          const sizeError = checkSize(file.size, sourceFileName);
          if (sizeError !== null) {
            store.addError(sizeError);
            return;
          }

          // 3. Parse with the parser selected by file type. Parsers throw an
          //    IntakeFailure (empty-file / bad-encoding / corrupt-file) on
          //    failure, caught below.
          const parser = parsers[fileType];
          const parsed: ParsedFile = await parser.parse(file);

          // 4. Infer column types from the parsed values (never throws, Req
          //    5.10).
          const inferred: ColumnSchema[] = typeInference.infer(
            parsed.columnNames,
            parsed.rows
          );

          // 5. Sanitize the table name (unique across this intake call) and the
          //    column names, then align the sanitized names onto the inferred
          //    schema by position.
          const tableName = sanitizer.sanitizeTableName(
            parsed.sourceFileName,
            existingTableNames
          );
          existingTableNames.push(tableName);

          const sanitizedColumns = sanitizer.sanitizeColumnNames(
            parsed.columnNames
          );
          const schema: ColumnSchema[] = inferred.map((col, index) => ({
            name: sanitizedColumns[index] ?? col.name,
            type: col.type,
          }));

          // 6. Create the typed table and insert all rows. On an unrecoverable
          //    failure the service throws an IntakeFailure (table-load-failed),
          //    caught below. The service's LoadedTable reports the tableName as
          //    its sourceFileName, so overwrite it with the real file name here.
          const loaded = await duckDBService.createTable(
            tableName,
            schema,
            parsed.rows
          );
          store.addTable({ ...loaded, sourceFileName });
        } catch (error) {
          // Parsers and the DuckDB service signal failures with a structured
          // IntakeFailure; record its embedded IntakeError directly (Req 6.8,
          // 9.1). Any other unexpected throw is wrapped as a loading failure so
          // it is still surfaced, named, and non-blocking (Req 9.2).
          if (isIntakeFailure(error)) {
            store.addError(error.intakeError);
          } else {
            store.addError(unexpectedError(sourceFileName, error));
          }
        }
      }
    },
  };
}

/** Build an `unsupported-type` {@link IntakeError} naming the file (Req 2.2). */
function unsupportedTypeError(sourceFileName: string): IntakeError {
  return {
    sourceFileName,
    stage: "validation",
    kind: "unsupported-type",
    message: `File "${sourceFileName}" is not a supported type; only .csv and .xlsx files are accepted.`,
  };
}

/**
 * Wrap an unexpected (non-{@link IntakeFailure}) throw as a
 * `table-load-failed` {@link IntakeError} so it is surfaced and named rather
 * than escaping the pipeline (Req 9.1, 9.2).
 */
function unexpectedError(sourceFileName: string, cause: unknown): IntakeError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return {
    sourceFileName,
    stage: "loading",
    kind: "table-load-failed",
    message: `File "${sourceFileName}" could not be loaded: ${reason}`,
  };
}
