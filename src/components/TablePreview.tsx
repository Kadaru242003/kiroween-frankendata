/**
 * TablePreview — renders a per-table preview card for each loaded DuckDBTable.
 *
 * Presentational only (Req 7): it receives the already-fetched preview rows and
 * does NOT call DuckDB. The App layer (task 19.1) is responsible for fetching
 * preview rows via `DuckDBService.getPreviewRows(tableName, 20)` and passing
 * them in. Keeping this component free of async/DuckDB coupling makes it simple
 * to render and test.
 *
 * Each card shows (Req 7.1–7.5):
 *  - 7.1: one card per loaded table.
 *  - 7.2: the first `min(rowCount, 20)` rows (previewRows, sliced to 20
 *         defensively — the caller is expected to pass at most 20).
 *  - 7.3: the column names (from `table.schema`) as the table header.
 *  - 7.4: the inferred `ColumnType` of each column, shown under the name.
 *  - 7.5: the total row count (`table.rowCount`), which may exceed the number
 *         of previewed rows.
 *
 * Detailed theming (readable headers, visible column separators) is refined in
 * task 14.3; the markup here uses classNames and semantic <table> structure so
 * that styling can target thead / separators without further changes.
 */
import type { LoadedTable } from '../core/types'
import './TablePreview.css'

/** The maximum number of rows a preview ever renders (Req 7.2). */
const PREVIEW_ROW_LIMIT = 20

/** A loaded table paired with its already-fetched preview rows. */
export interface TablePreviewData {
  table: LoadedTable
  /**
   * Preview rows for the table, keyed by sanitized column name. Expected to be
   * limited to 20 by the caller (via `getPreviewRows(tableName, 20)`); this
   * component slices to 20 defensively regardless.
   */
  previewRows: Record<string, unknown>[]
}

export interface TablePreviewProps {
  /** The tables to preview; one card is rendered per entry (Req 7.1). */
  tables: TablePreviewData[]
}

/**
 * Render a cell value into a readable string. `null` / `undefined` are the
 * expected representation of a stored SQL `NULL` (from a `NullToken`) and are
 * rendered as a muted "NULL" marker rather than an empty cell.
 */
function renderCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: 'NULL', isNull: true }
  }
  if (typeof value === 'string') {
    return { text: value, isNull: false }
  }
  if (value instanceof Date) {
    return { text: value.toISOString().slice(0, 10), isNull: false }
  }
  return { text: String(value), isNull: false }
}

/** A singular, human-friendly "N row" / "N rows" label (Req 7.5). */
function rowCountLabel(rowCount: number): string {
  return `${rowCount.toLocaleString()} ${rowCount === 1 ? 'row' : 'rows'}`
}

/** A single table's preview card. */
function TablePreviewCard({ table, previewRows }: TablePreviewData) {
  const { tableName, sourceFileName, schema, rowCount } = table
  // Guard defensively: never render more than 20 rows even if the caller
  // passed more (Req 7.2).
  const rows = previewRows.slice(0, PREVIEW_ROW_LIMIT)
  const shownRowCount = Math.min(rowCount, PREVIEW_ROW_LIMIT)

  return (
    <section className="table-preview-card" aria-label={`Preview of ${tableName}`}>
      <header className="table-preview-card__header">
        <h3 className="table-preview-card__title">{tableName}</h3>
        <p className="table-preview-card__source">{sourceFileName}</p>
        <p className="table-preview-card__rowcount">{rowCountLabel(rowCount)}</p>
      </header>

      <div className="table-preview-card__scroll">
        <table className="table-preview-card__table">
          <caption className="table-preview-card__caption">
            {`Table ${tableName}, showing ${shownRowCount} of ${rowCountLabel(
              rowCount,
            )}`}
          </caption>
          <thead className="table-preview-card__thead">
            <tr>
              {schema.map((column) => (
                <th
                  key={column.name}
                  scope="col"
                  className="table-preview-card__th"
                >
                  <span className="table-preview-card__col-name">
                    {column.name}
                  </span>
                  <span className="table-preview-card__col-type">
                    {column.type}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="table-preview-card__tbody">
            {rows.length === 0 ? (
              <tr>
                <td
                  className="table-preview-card__empty"
                  colSpan={Math.max(schema.length, 1)}
                >
                  No rows to preview
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {schema.map((column) => {
                    const { text, isNull } = renderCell(row[column.name])
                    return (
                      <td
                        key={column.name}
                        className={
                          isNull
                            ? 'table-preview-card__td table-preview-card__td--null'
                            : 'table-preview-card__td'
                        }
                      >
                        {text}
                      </td>
                    )
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * Renders one {@link TablePreviewCard} per loaded table (Req 7.1). When there
 * are no tables, renders nothing so the App can decide what empty-state UI to
 * show.
 */
export function TablePreview({ tables }: TablePreviewProps) {
  if (tables.length === 0) {
    return null
  }
  return (
    <div className="table-preview">
      {tables.map(({ table, previewRows }) => (
        <TablePreviewCard
          key={table.tableName}
          table={table}
          previewRows={previewRows}
        />
      ))}
    </div>
  )
}

export default TablePreview
