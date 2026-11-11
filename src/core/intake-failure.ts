/**
 * Shared error type thrown by file parsers.
 *
 * The {@link FileParser.parse} contract returns `Promise<ParsedFile>`, so parse
 * failures are surfaced by rejecting the promise. To keep the failure
 * structured (rather than a bare `Error` with a string message), parsers throw
 * an {@link IntakeFailure}, which carries a fully-formed {@link IntakeError}
 * describing the stage, kind, and file. The `IntakeController` (task 12.1) can
 * then catch this error and record the embedded `IntakeError` directly.
 *
 * Both {@link CsvParser} and {@link XlsxParser} (task 6.1) MUST use this
 * convention so the controller handles parse failures uniformly.
 */

import type { IntakeError } from "./types";

/**
 * An `Error` subclass that wraps a structured {@link IntakeError}.
 *
 * Thrown by parsers when a file cannot be parsed (e.g. empty file, bad
 * encoding, corrupt workbook). The wrapped `intakeError` is the canonical
 * failure record; `message` mirrors `intakeError.message` so standard error
 * logging remains useful.
 */
export class IntakeFailure extends Error {
  /** The structured failure record to be recorded by the controller. */
  readonly intakeError: IntakeError;

  constructor(intakeError: IntakeError) {
    super(intakeError.message);
    this.name = "IntakeFailure";
    this.intakeError = intakeError;
    // Preserve the prototype chain when compiling to older targets.
    Object.setPrototypeOf(this, IntakeFailure.prototype);
  }
}

/**
 * Type guard for {@link IntakeFailure}. Prefer this over `instanceof` at catch
 * sites so the embedded {@link IntakeError} can be read safely.
 */
export function isIntakeFailure(value: unknown): value is IntakeFailure {
  return value instanceof IntakeFailure;
}
