/**
 * Column type inference for the FrankenData file-intake pipeline.
 *
 * `createTypeInferenceLayer` returns an implementation of the
 * {@link TypeInferenceLayer} interface. The single method, `infer`, is pure
 * over its inputs and **never throws** (Req 5.10): it returns a
 * {@link ColumnSchema}[] with exactly one entry per column name, each carrying
 * a {@link ColumnType} (Req 5.1, 5.3).
 *
 * ## Classification (design.md, "Column classification")
 *
 * For each column, `NullToken` values are excluded (via {@link isNullToken},
 * Req 5.2). The remaining non-`NullToken` values are classified in order:
 *
 *   1. every value satisfies {@link isNumber}  → `number`
 *   2. else every value satisfies {@link isBoolean} → `boolean`
 *   3. else every value satisfies {@link isDate}   → `date`
 *   4. else                                        → `string` (Req 5.8)
 *
 * A column with **zero** non-`NullToken` values (all `NullToken`s, or no cells
 * at all) is classified as `string` (Req 5.9). Because the predicates are
 * mutually exclusive over any single value, the check order is unambiguous for
 * uniform columns and mixed columns always fall through to `string`.
 *
 * Column values are read by index across every row. Rows are tolerated
 * defensively: a ragged row that is shorter than `columnNames` (or a row that
 * is not an array) contributes a missing cell for the absent columns, which is
 * treated as a `NullToken`. This means a malformed `rows` input can never make
 * `infer` throw — it degrades to `string` for the affected columns.
 *
 * Inference does **not** rely on DuckDB auto-typing; the inferred
 * `ColumnType`s are what later drive explicit DuckDB table creation.
 *
 * The returned schema `name` is the column name exactly as given.
 * Sanitization into a valid DuckDB identifier is the NameSanitizer's job and
 * is deliberately NOT done here.
 */

import { isBoolean, isDate, isNullToken, isNumber } from "./predicates";
import type { CellValue, ColumnSchema, ColumnType, TypeInferenceLayer } from "./types";

/**
 * Classify a single column's values into a {@link ColumnType}.
 *
 * `NullToken` values are excluded first. If nothing remains, the column is
 * `string` (Req 5.9). Otherwise the non-`NullToken` values are checked against
 * {@link isNumber}/{@link isBoolean}/{@link isDate} in that order; the first
 * predicate satisfied by *every* value wins, else the column is `string`
 * (Req 5.8).
 */
function classifyColumn(values: CellValue[]): ColumnType {
  const present = values.filter((value) => !isNullToken(value));

  // All NullTokens (or no values) → string (Req 5.9).
  if (present.length === 0) {
    return "string";
  }

  if (present.every(isNumber)) {
    return "number";
  }
  if (present.every(isBoolean)) {
    return "boolean";
  }
  if (present.every(isDate)) {
    return "date";
  }
  return "string";
}

/**
 * Read the value at `columnIndex` from a single row, tolerating ragged or
 * malformed rows. A non-array row, or a row shorter than `columnIndex + 1`,
 * yields `null` (treated downstream as a `NullToken`).
 */
function cellAt(row: CellValue[], columnIndex: number): CellValue {
  if (!Array.isArray(row)) {
    return null;
  }
  const cell = row[columnIndex];
  return cell === undefined ? null : cell;
}

/**
 * Create a stateless {@link TypeInferenceLayer}. The returned object holds no
 * cross-call state; the arguments to each `infer` call fully determine its
 * result.
 */
export function createTypeInferenceLayer(): TypeInferenceLayer {
  return {
    infer(columnNames: string[], rows: CellValue[][]): ColumnSchema[] {
      // Defensive: never throw for any input (Req 5.10). Normalize the inputs
      // so malformed arguments degrade gracefully rather than raising.
      const names = Array.isArray(columnNames) ? columnNames : [];
      const dataRows = Array.isArray(rows) ? rows : [];

      return names.map((name, columnIndex) => {
        const columnValues = dataRows.map((row) => cellAt(row, columnIndex));
        return { name, type: classifyColumn(columnValues) };
      });
    },
  };
}

/** A ready-to-use shared instance, since the layer holds no state. */
export const typeInferenceLayer: TypeInferenceLayer = createTypeInferenceLayer();
