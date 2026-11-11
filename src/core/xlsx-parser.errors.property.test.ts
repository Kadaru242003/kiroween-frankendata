/**
 * Property-based tests for {@link XlsxParser} error detection.
 *
 * Feature: frankendata-file-intake
 *   - Property 3: Empty file detection (XLSX portion)
 *   - Property 4: Unreadable file detection (XLSX portion)
 *
 * Validates: Requirements 4.2, 4.3
 *
 * Property statements (design.md):
 *  - Property 3: For any XLSX with no sheets or zero data rows, the system
 *    reports an empty-file error that names the file (Req 4.2).
 *  - Property 4: For any corrupt/unreadable XLSX, the system reports a read
 *    (corrupt-file) error that names the file (Req 4.3).
 *
 * Strategy:
 *  - Empty case: build a *valid* workbook with SheetJS that nevertheless has
 *    zero data rows — either a sheet containing only a header row, or a fully
 *    empty sheet. Serialize it to real XLSX bytes via `XLSX.write`, wrap in a
 *    File, and assert `parse` throws an `IntakeFailure` whose embedded
 *    `IntakeError` is `{ stage: "parsing", kind: "empty-file" }` and names the
 *    file.
 *  - Corrupt case: an XLSX is a ZIP container whose first bytes are the ZIP
 *    local-file-header magic `PK\x03\x04`. We generate payloads that carry that
 *    magic (so SheetJS recognizes a ZIP and tries to inflate it) followed by
 *    garbage/truncated bytes, so the unzip step fails and SheetJS throws — which
 *    the parser maps to `corrupt-file`. This reliably targets the read-error
 *    path rather than the empty-workbook path (SheetJS is lenient about tiny
 *    non-ZIP buffers and treats them as empty workbooks, which is a different
 *    error kind). Assert `parse` throws an `IntakeFailure` whose embedded
 *    `IntakeError` is `{ stage: "parsing", kind: "corrupt-file" }` and names the
 *    file.
 */

import * as XLSX from "xlsx";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { XlsxParser } from "./xlsx-parser";
import { isIntakeFailure } from "./intake-failure";

/** Minimum fast-check iterations per the design testing strategy. */
const NUM_RUNS = 100;

/**
 * A single header/cell token. Restricted to a plain alphanumeric-ish charset so
 * the generated workbook content is unambiguous; non-empty so a header cell is
 * never itself blank.
 */
const tokenArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(
        ""
      )
    ),
    minLength: 1,
    maxLength: 10,
  })
  .filter((s) => s.length > 0);

/**
 * Build real XLSX bytes for a workbook whose first sheet has zero data rows.
 * `aoa` is the array-of-arrays passed to SheetJS: either a single header row
 * (`[[...headers]]`) or a completely empty sheet (`[]`).
 */
function emptyWorkbookBytes(aoa: string[][]): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
  // `type: "array"` yields a Uint8Array of a real XLSX (ZIP) file.
  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

/** Wrap bytes in a File with the given .xlsx name. */
function xlsxFile(bytes: Uint8Array, name: string): File {
  return new File([bytes as BlobPart], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("XlsxParser — Property 3: Empty file detection (XLSX portion)", () => {
  const parser = new XlsxParser();

  it("reports an empty-file error naming the file for a header-only or empty sheet", async () => {
    // Either a sheet with only a header row (>= 1 columns, zero data rows) or a
    // fully empty sheet. Both are valid workbooks with zero data rows.
    const emptyAoaArb: fc.Arbitrary<string[][]> = fc.oneof(
      // header-only sheet
      fc
        .array(tokenArb, { minLength: 1, maxLength: 6 })
        .map((header) => [header]),
      // completely empty sheet
      fc.constant([] as string[][])
    );

    await fc.assert(
      fc.asyncProperty(
        emptyAoaArb,
        tokenArb,
        async (aoa, baseName) => {
          const fileName = `${baseName}.xlsx`;
          const bytes = emptyWorkbookBytes(aoa);
          const file = xlsxFile(bytes, fileName);

          let thrown: unknown;
          try {
            await parser.parse(file);
          } catch (err) {
            thrown = err;
          }

          // parse must reject (not resolve) for a zero-data-row workbook.
          expect(thrown, "expected parse to throw for an empty workbook").toBeDefined();
          expect(isIntakeFailure(thrown)).toBe(true);
          if (!isIntakeFailure(thrown)) return; // narrowing for TS

          const { intakeError } = thrown;
          expect(intakeError.stage).toBe("parsing");
          expect(intakeError.kind).toBe("empty-file");
          // The error names the offending file (Req 4.2).
          expect(intakeError.sourceFileName).toBe(fileName);
          expect(intakeError.message).toContain(fileName);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

describe("XlsxParser — Property 4: Unreadable file detection (XLSX portion)", () => {
  const parser = new XlsxParser();

  it("reports a corrupt-file error naming the file for corrupt ZIP (xlsx) bytes", async () => {
    // XLSX files are ZIP archives beginning with the local-file-header magic
    // "PK\x03\x04". Prefixing that magic makes SheetJS recognize a ZIP container
    // and attempt to inflate it; the trailing garbage/truncated bytes make the
    // inflate fail, so SheetJS throws and the parser maps it to `corrupt-file`.
    const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
    const corruptBytesArb: fc.Arbitrary<Uint8Array> = fc
      .array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 64 })
      .map((garbage) => Uint8Array.from([...ZIP_MAGIC, ...garbage]));

    await fc.assert(
      fc.asyncProperty(
        corruptBytesArb,
        tokenArb,
        async (bytes, baseName) => {
          const fileName = `${baseName}.xlsx`;
          const file = xlsxFile(bytes, fileName);

          let thrown: unknown;
          try {
            await parser.parse(file);
          } catch (err) {
            thrown = err;
          }

          // parse must reject (not resolve) for unreadable/corrupt bytes.
          expect(thrown, "expected parse to throw for corrupt bytes").toBeDefined();
          expect(isIntakeFailure(thrown)).toBe(true);
          if (!isIntakeFailure(thrown)) return; // narrowing for TS

          const { intakeError } = thrown;
          expect(intakeError.stage).toBe("parsing");
          // Target corrupt-file (the read/parse error kind, Req 4.3).
          expect(intakeError.kind).toBe("corrupt-file");
          // The error names the offending file (Req 4.3).
          expect(intakeError.sourceFileName).toBe(fileName);
          expect(intakeError.message).toContain(fileName);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
