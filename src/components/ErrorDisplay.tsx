import type { IntakeError } from '../core/types'
import './ErrorDisplay.css'

export interface ErrorDisplayProps {
  /**
   * The intake errors to surface. Prop-driven for testability: the App wires
   * this to the IntakeStore state (task 19.1) rather than the component
   * subscribing to the store itself.
   */
  errors: IntakeError[]
}

/**
 * Renders the list of {@link IntakeError} entries in a panel that is visible
 * without obscuring the table previews (Req 9.3). Each error names the source
 * file and describes the failure (Req 9.1).
 *
 * The panel is a normal in-flow `<section>` (not a modal/overlay), so it sits
 * alongside the previews instead of covering them. It is announced to assistive
 * technology via `role="region"` and an accessible label.
 *
 * When there are no errors, nothing is rendered — the component does not show
 * an empty panel.
 */
/**
 * Friendly, user-facing message for an intake error. For a corrupt or
 * unreadable `.xlsx` file (for example a renamed text file), show a clear
 * sentence instead of the raw SheetJS parser detail. All other errors keep
 * their existing message.
 */
export function friendlyMessage(error: IntakeError): string {
  const isXlsx = error.sourceFileName.toLowerCase().endsWith('.xlsx')
  if (error.kind === 'corrupt-file' && isXlsx) {
    return "This doesn't look like a valid .xlsx file."
  }
  return error.message
}

export function ErrorDisplay({ errors }: ErrorDisplayProps) {
  if (errors.length === 0) {
    return null
  }

  return (
    <section
      className="error-display"
      role="region"
      aria-label="File intake errors"
    >
      <h2 className="error-display__title">File intake errors</h2>
      <ul className="error-display__list">
        {errors.map((error, index) => (
          <li
            key={`${error.sourceFileName}-${error.kind}-${index}`}
            className="error-display__item"
          >
            <div>
              <span className="error-display__file">
                {error.sourceFileName}
              </span>
              <span className="error-display__kind">{error.kind}</span>
            </div>
            <p className="error-display__message">{friendlyMessage(error)}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default ErrorDisplay
