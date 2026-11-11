/**
 * App — top-level wiring for the FrankenData file-intake pipeline (task 19.1).
 *
 * This component composes the whole feature in the browser:
 *
 *   - Creates the single in-memory DuckDB-WASM service on app start and
 *     initializes it exactly once (guarded against React StrictMode's
 *     double-mount via a module-level singleton promise), then builds the
 *     {@link IntakeController} wired to that service and the app-wide
 *     {@link intakeStore} (Req 11.1, 11.2).
 *   - Subscribes to the store via {@link useIntakeStore} to render loaded
 *     tables and errors reactively (Req 7.1, 9.3).
 *   - Mounts the {@link DropZone} and {@link DemoDataControl} side by side and
 *     connects them to the controller: dropped files and bundled demo files run
 *     through the identical `intake` pipeline (Req 1.1, 13.1, 13.2).
 *   - Fetches up to 20 preview rows per loaded table from DuckDB and feeds them
 *     to {@link TablePreview} (Req 7.2).
 *   - Surfaces intake errors through {@link ErrorDisplay}, placed above the
 *     previews in normal flow so it never obscures them (Req 9.3).
 *
 * The browser DuckDB bundle fetches its Wasm/worker assets from a CDN at
 * runtime — that is the expected app path and must not run under the test
 * runner, so all DuckDB wiring lives here in the Vite entry component.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createDuckDBService } from './db/duckdb-service'
import { createIntakeController } from './core/intake-controller'
import { demoDataLoader } from './core/demo-data-loader'
import { intakeStore, useIntakeStore } from './state/intake-store'
import type { DuckDBService, IntakeController, LoadedTable } from './core/types'
import { DropZone } from './components/DropZone'
import { DemoDataControl } from './components/DemoDataControl'
import { TablePreview, type TablePreviewData } from './components/TablePreview'
import { ErrorDisplay } from './components/ErrorDisplay'
import './App.css'

/** The number of rows fetched per table for the preview (Req 7.2). */
const PREVIEW_ROW_LIMIT = 20

/**
 * The lab stack: the single DuckDB service plus the controller wired to it and
 * the app-wide store. Resolving the ready promise means the DuckDB-WASM
 * instance has been initialized and the pipeline is ready to accept files.
 */
interface LabStack {
  duckDBService: DuckDBService
  controller: IntakeController
}

/**
 * Module-level singleton promise for initializing the DuckDB service and
 * building the controller. React StrictMode mounts effects twice in dev;
 * caching the promise here guarantees `init()` runs — and a single in-memory
 * DuckDB instance is created — exactly once regardless of how many times the
 * effect fires.
 */
let labStackPromise: Promise<LabStack> | null = null

/** Initialize the DuckDB service once and build the wired controller. */
function getLabStack(): Promise<LabStack> {
  if (labStackPromise === null) {
    labStackPromise = (async () => {
      const duckDBService = createDuckDBService()
      await duckDBService.init()
      const controller = createIntakeController({
        duckDBService,
        store: intakeStore,
      })
      return { duckDBService, controller }
    })()
  }
  return labStackPromise
}

/** The lab's initialization lifecycle, surfaced to the UI. */
type LabStatus =
  | { phase: 'initializing' }
  | { phase: 'ready'; stack: LabStack }
  | { phase: 'error'; message: string }

function App() {
  const [status, setStatus] = useState<LabStatus>({ phase: 'initializing' })
  const { tables, errors } = useIntakeStore()

  // Initialize DuckDB + controller once on mount. The module-level singleton
  // promise makes this safe under StrictMode's double-invoke.
  useEffect(() => {
    let cancelled = false
    getLabStack()
      .then((stack) => {
        if (!cancelled) {
          setStatus({ phase: 'ready', stack })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          setStatus({ phase: 'error', message })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const stack = status.phase === 'ready' ? status.stack : null

  const handleFiles = useCallback(
    (files: File[]) => {
      if (stack === null || files.length === 0) {
        return
      }
      void stack.controller.intake(files)
    },
    [stack],
  )

  const handleLoadDemo = useCallback(async () => {
    if (stack === null) {
      return
    }
    const files = await demoDataLoader.load()
    await stack.controller.intake(files)
  }, [stack])

  return (
    <main id="lab">
      <header className="lab-header">
        <h1 className="lab-title">FrankenData</h1>
        <p className="lab-subtitle">
          Drag messy CSV or XLSX files into the lab and watch them come alive.
        </p>
      </header>

      {status.phase === 'initializing' ? (
        <section className="lab-status lab-status--loading" role="status">
          <p>Summoning the lab…</p>
        </section>
      ) : null}

      {status.phase === 'error' ? (
        <section className="lab-status lab-status--error" role="alert">
          <p>The lab failed to wake up: {status.message}</p>
        </section>
      ) : null}

      {status.phase === 'ready' ? (
        <>
          <section className="lab-intake" aria-label="File intake">
            <DropZone onFiles={handleFiles} />
            <DemoDataControl onLoadDemo={handleLoadDemo} />
          </section>

          <ErrorDisplay errors={[...errors]} />

          <TablePreviewRegion
            tables={tables}
            duckDBService={status.stack.duckDBService}
          />
        </>
      ) : null}
    </main>
  )
}

/** Props for {@link TablePreviewRegion}. */
interface TablePreviewRegionProps {
  tables: readonly LoadedTable[]
  duckDBService: DuckDBService
}

/**
 * Fetches preview rows for every loaded table and renders {@link TablePreview}.
 *
 * Whenever the store's table list changes, this queries up to
 * {@link PREVIEW_ROW_LIMIT} rows per table from DuckDB and stores the assembled
 * `{ table, previewRows }` array in local state. Tables render immediately with
 * empty previews and fill in as their rows resolve, so the async fetch never
 * blocks the UI (Req 7.2).
 */
function TablePreviewRegion({ tables, duckDBService }: TablePreviewRegionProps) {
  const [previews, setPreviews] = useState<TablePreviewData[]>([])
  // Track the latest effect run so a stale fetch (from a superseded table list)
  // cannot overwrite fresher preview data.
  const runIdRef = useRef(0)

  useEffect(() => {
    const runId = ++runIdRef.current

    // Show the tables right away with empty previews; fill rows in as they load.
    setPreviews(tables.map((table) => ({ table, previewRows: [] })))

    let cancelled = false

    void Promise.all(
      tables.map(async (table) => {
        try {
          const previewRows = await duckDBService.getPreviewRows(
            table.tableName,
            PREVIEW_ROW_LIMIT,
          )
          return { table, previewRows }
        } catch {
          // A preview-query failure must not break the whole region; show the
          // table with no rows rather than crashing.
          return { table, previewRows: [] as Record<string, unknown>[] }
        }
      }),
    ).then((assembled) => {
      if (!cancelled && runId === runIdRef.current) {
        setPreviews(assembled)
      }
    })

    return () => {
      cancelled = true
    }
  }, [tables, duckDBService])

  return <TablePreview tables={previews} />
}

export default App
