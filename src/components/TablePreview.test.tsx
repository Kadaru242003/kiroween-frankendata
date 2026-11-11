/**
 * Minimal render smoke tests for TablePreview (task 16.1).
 *
 * These assert the functional rendering contract (Req 7.1–7.5): one card per
 * table, column names, inferred types, row count, preview rows, NULL handling,
 * and the defensive 20-row slice. The property test for preview completeness is
 * task 16.2 and is intentionally not implemented here.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LoadedTable } from '../core/types'
import { TablePreview, type TablePreviewData } from './TablePreview'

function makeTable(overrides: Partial<LoadedTable> = {}): LoadedTable {
  return {
    loadId: 1,
    tableName: 'sales_2024',
    sourceFileName: 'Sales 2024.csv',
    schema: [
      { name: 'amount', type: 'number' },
      { name: 'active', type: 'boolean' },
      { name: 'label', type: 'string' },
    ],
    rowCount: 3,
    ...overrides,
  }
}

describe('TablePreview', () => {
  it('renders nothing when there are no tables', () => {
    const { container } = render(<TablePreview tables={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one card per loaded table (Req 7.1)', () => {
    const data: TablePreviewData[] = [
      { table: makeTable({ tableName: 'a' }), previewRows: [] },
      { table: makeTable({ tableName: 'b' }), previewRows: [] },
    ]
    render(<TablePreview tables={data} />)
    expect(screen.getByRole('heading', { name: 'a' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'b' })).toBeInTheDocument()
  })

  it('shows column names and their inferred types (Req 7.3, 7.4)', () => {
    render(
      <TablePreview tables={[{ table: makeTable(), previewRows: [] }]} />,
    )
    const amountHeader = screen.getByRole('columnheader', { name: /amount/ })
    expect(within(amountHeader).getByText('amount')).toBeInTheDocument()
    expect(within(amountHeader).getByText('number')).toBeInTheDocument()

    const activeHeader = screen.getByRole('columnheader', { name: /active/ })
    expect(within(activeHeader).getByText('boolean')).toBeInTheDocument()
  })

  it('shows the total row count, which may exceed previewed rows (Req 7.5)', () => {
    const table = makeTable({ rowCount: 100 })
    const previewRows = Array.from({ length: 20 }, (_, i) => ({
      amount: String(i),
      active: 'true',
      label: `row ${i}`,
    }))
    render(<TablePreview tables={[{ table, previewRows }]} />)
    expect(screen.getByText('100 rows')).toBeInTheDocument()
  })

  it('renders preview cells by column order and marks NULLs', () => {
    const table = makeTable({ rowCount: 1 })
    const previewRows = [{ amount: '12.5', active: null, label: 'hi' }]
    render(<TablePreview tables={[{ table, previewRows }]} />)
    expect(screen.getByText('12.5')).toBeInTheDocument()
    expect(screen.getByText('hi')).toBeInTheDocument()
    expect(screen.getByText('NULL')).toBeInTheDocument()
  })

  it('defensively renders at most 20 rows even if more are passed (Req 7.2)', () => {
    const table = makeTable({ rowCount: 50 })
    const previewRows = Array.from({ length: 30 }, (_, i) => ({
      amount: String(i),
      active: 'true',
      label: `row ${i}`,
    }))
    render(<TablePreview tables={[{ table, previewRows }]} />)
    // 20 body rows (row 0..19). Row index 20+ should not be rendered.
    expect(screen.getByText('row 19')).toBeInTheDocument()
    expect(screen.queryByText('row 20')).not.toBeInTheDocument()
  })
})
