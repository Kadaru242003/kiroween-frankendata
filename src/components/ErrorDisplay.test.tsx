import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { IntakeError } from '../core/types'
import { ErrorDisplay } from './ErrorDisplay'

describe('ErrorDisplay', () => {
  it('renders nothing when there are no errors', () => {
    const { container } = render(<ErrorDisplay errors={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the file and describes the failure for each error (Req 9.1)', () => {
    const errors: IntakeError[] = [
      {
        sourceFileName: 'budget.txt',
        stage: 'validation',
        message: 'Unsupported file type: only .csv and .xlsx files are accepted.',
        kind: 'unsupported-type',
      },
      {
        sourceFileName: 'sales.csv',
        stage: 'parsing',
        message: 'The file is empty.',
        kind: 'empty-file',
      },
    ]

    render(<ErrorDisplay errors={errors} />)

    // Names each file.
    expect(screen.getByText('budget.txt')).toBeInTheDocument()
    expect(screen.getByText('sales.csv')).toBeInTheDocument()

    // Describes each failure.
    expect(
      screen.getByText(/only \.csv and \.xlsx files are accepted/i)
    ).toBeInTheDocument()
    expect(screen.getByText('The file is empty.')).toBeInTheDocument()
  })

  it('shows a friendly message for a corrupt .xlsx (e.g. a renamed text file)', () => {
    const errors: IntakeError[] = [
      {
        sourceFileName: 'notreally.xlsx',
        stage: 'parsing',
        message:
          'File "notreally.xlsx" could not be read; it may be corrupt or not a valid XLSX workbook: zip file read error.',
        kind: 'corrupt-file',
      },
    ]

    render(<ErrorDisplay errors={errors} />)

    // The raw parser detail is replaced by a clear, friendly sentence.
    expect(
      screen.getByText("This doesn't look like a valid .xlsx file.")
    ).toBeInTheDocument()
    expect(screen.queryByText(/zip file read error/i)).toBeNull()
  })

  it('exposes an accessible region so errors are announced (Req 9.3)', () => {
    const errors: IntakeError[] = [
      {
        sourceFileName: 'data.csv',
        stage: 'loading',
        message: 'Table load failed.',
        kind: 'table-load-failed',
      },
    ]

    render(<ErrorDisplay errors={errors} />)

    expect(
      screen.getByRole('region', { name: /file intake errors/i })
    ).toBeInTheDocument()
  })
})
