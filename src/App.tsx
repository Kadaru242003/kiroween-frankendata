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
import { StitchStore } from './core/stitching/stitch-store'
import {
  createStitchController,
  type LoadedTablesProvider,
} from './core/stitching/stitch-controller'
import type { StitchController, StitchPlan } from './core/stitching/types'
import { useStitchStore } from './core/stitching/stitch-store'
import {
  ApprovalScreen,
  type ApprovalScreenTable,
} from './components/stitching/ApprovalScreen'
import {
  StitchEntryPoint,
  shouldShowStitchEntry,
} from './components/stitching/StitchEntryPoint'
import {
  JoinControls,
  type JoinControlsTable,
} from './components/stitching/JoinControls'
import './App.css'

/** The number of rows fetched per table for the preview (Req 7.2). */
const PREVIEW_ROW_LIMIT = 20

/** Idle label for the second demo action: the mismatched stitching dataset (Req 8.4). */
const LOAD_MISMATCHED_DEMO_LABEL = 'Load mismatched demo'

/**
 * The lab stack: the single DuckDB service plus the controller wired to it and
 * the app-wide store. Resolving the ready promise means the DuckDB-WASM
 * instance has been initialized and the pipeline is ready to accept files.
 */
interface LabStack {
  duckDBService: DuckDBService
  controller: IntakeController
  /** Session-only state the stitching approval screen reads and writes. */
  stitchStore: StitchStore
  /** Rules-only orchestration for the stitching stage (Feature 2). */
  stitchController: StitchController
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
      // Feature 2 stitching stack, wired to the same DuckDB instance and reading
      // the live loaded-table set from the intake store. Rules-only (no AI
      // provider injected) per task 13.
      const stitchStore = new StitchStore()
      const getTables: LoadedTablesProvider = () =>
        intakeStore.getState().tables
      const stitchController = createStitchController({
        db: duckDBService,
        getTables,
        store: stitchStore,
      })
      return { duckDBService, controller, stitchStore, stitchController }
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
  // Whether the stitching approval screen is currently open. Only reachable
  // once two or more tables are loaded; see MIN_TABLES_FOR_STITCHING.
  const [stitchOpen, setStitchOpen] = useState(false)
  // The plan the user confirmed on the approval screen and is now adjusting in
  // JoinControls (anchor + per-pair join keys). null until confirm; cleared on
  // undo. Nothing is applied to DuckDB until the user hits "Apply & stitch".
  const [workingPlan, setWorkingPlan] = useState<StitchPlan | null>(null)

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

  // Load the second, mismatched demo dataset (Req 8.1–8.4) through the SAME
  // intake pipeline as dropped files and the first demo. Its two files (same
  // creatures, different headers) push the loaded-table count to two, which is
  // what makes the stitching stage reachable (Req 8.4).
  const handleLoadMismatchedDemo = useCallback(async () => {
    if (stack === null) {
      return
    }
    const files = await demoDataLoader.loadMismatched()
    await stack.controller.intake(files)
  }, [stack])

  const canStitch = shouldShowStitchEntry(tables.length)

  // Opening the stitch screen computes proposals for the current table set
  // (rules-only). Any compute failure is swallowed — the screen simply shows an
  // empty state rather than crashing the lab.
  const handleOpenStitch = useCallback(() => {
    if (stack === null || !canStitch) {
      return
    }
    setStitchOpen(true)
    void stack.stitchController.computeProposals().catch(() => {
      // Non-fatal: leave the screen open with whatever (possibly empty) state
      // the store holds.
    })
  }, [stack, canStitch])

  const handleCloseStitch = useCallback(() => {
    setStitchOpen(false)
  }, [])

  // The user confirmed on the approval screen: hold the assembled plan so the
  // JoinControls can adjust the anchor / join keys before applying. Nothing is
  // applied yet (Req 3.5 — apply only on an explicit action).
  const handleConfirmPlan = useCallback((plan: StitchPlan) => {
    setWorkingPlan(plan)
  }, [])

  // Change the anchor table (Req 7.2): reshape the working plan only.
  const handleChangeAnchor = useCallback((nextAnchorTableName: string) => {
    setWorkingPlan((prev) =>
      prev === null ? prev : { ...prev, anchorTableName: nextAnchorTableName },
    )
  }, [])

  // Pick a different approved match as a pair's join key (Req 7.4): reshape the
  // working plan's joinKeysByPair only.
  const handleChangeJoinKey = useCallback(
    (pairKeyValue: string, nextMatchId: string) => {
      setWorkingPlan((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              joinKeysByPair: {
                ...prev.joinKeysByPair,
                [pairKeyValue]: nextMatchId,
              },
            },
      )
    },
    [],
  )

  // Apply the working plan: create the stitched table (cleaned copies + LEFT
  // JOIN) and surface it via TablePreview. The fan-out counts land in the store
  // for the JoinControls warning (Req 7.9, 7.11). A failure is swallowed so the
  // lab stays usable.
  const handleApplyPlan = useCallback(() => {
    if (stack === null || workingPlan === null) {
      return
    }
    void stack.stitchController.applyPlan(workingPlan).catch(() => {
      // Non-fatal: leave the controls in place without a stitched preview.
    })
  }, [stack, workingPlan])

  // Cancel/undo the applied stitch (the fan-out Cancel action, Req 7.9): drop
  // the created stitch_* tables and remove the preview, keeping the working
  // plan so the user can adjust and re-apply.
  const handleUndoStitch = useCallback(() => {
    if (stack === null) {
      return
    }
    void stack.stitchController.undo().catch(() => {
      // Non-fatal.
    })
  }, [stack])

  // If the loaded-table set drops below the stitch minimum (e.g. a future reset
  // flow), close the screen so a stale view is never shown without an entry
  // point.
  useEffect(() => {
    if (!canStitch && stitchOpen) {
      setStitchOpen(false)
      setWorkingPlan(null)
    }
  }, [canStitch, stitchOpen])

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
            {/*
              Second demo action: the mismatched stitching dataset (Req 8.4).
              Routes through the identical intake pipeline; its two tables make
              the stitching stage reachable.
            */}
            <DemoDataControl
              onLoadDemo={handleLoadMismatchedDemo}
              label={LOAD_MISMATCHED_DEMO_LABEL}
            />
          </section>

          <ErrorDisplay errors={[...errors]} />

          {/*
            Stitch entry point: visible ONLY when two or more tables are loaded
            (design "Fewer than two tables"). Hidden otherwise — including while
            the screen is already open — so the approval screen is unreachable
            until stitching is meaningful.
          */}
          {stitchOpen ? null : (
            <StitchEntryPoint
              tableCount={tables.length}
              onOpen={handleOpenStitch}
            />
          )}

          {canStitch && stitchOpen ? (
            <section className="lab-stitch" aria-label="Stitching table">
              <button
                type="button"
                className="lab-stitch__close"
                onClick={handleCloseStitch}
              >
                Back to tables
              </button>
              <ApprovalScreen
                store={status.stack.stitchStore}
                tables={tables as readonly ApprovalScreenTable[]}
                onConfirm={handleConfirmPlan}
              />
              {/*
                After confirm, JoinControls let the user set the anchor / join
                keys (Req 7.2, 7.4), apply (which creates + previews the
                stitched result, Req 7.11), and see the many-to-many fan-out
                warning with a cancel/undo (Req 7.9).
              */}
              {workingPlan !== null ? (
                <StitchStage
                  store={status.stack.stitchStore}
                  plan={workingPlan}
                  tables={tables}
                  duckDBService={status.stack.duckDBService}
                  onChangeAnchor={handleChangeAnchor}
                  onChangeJoinKey={handleChangeJoinKey}
                  onApply={handleApplyPlan}
                  onCancel={handleUndoStitch}
                />
              ) : null}
            </section>
          ) : null}

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

/** Props for {@link StitchStage}. */
interface StitchStageProps {
  store: StitchStore
  plan: StitchPlan
  tables: readonly LoadedTable[]
  duckDBService: DuckDBService
  onChangeAnchor: (nextAnchorTableName: string) => void
  onChangeJoinKey: (pairKeyValue: string, nextMatchId: string) => void
  onApply: () => void
  onCancel: () => void
}

/**
 * The post-confirm stitch stage: the {@link JoinControls} (anchor / join keys /
 * apply / fan-out warning) plus the stitched-result preview rendered with the
 * existing {@link TablePreview} (Req 7.2, 7.4, 7.9, 7.11).
 *
 * Subscribes to the {@link StitchStore} via {@link useStitchStore} so the
 * applied stitched table, the fan-out counts, and the applied/undone state all
 * drive the view reactively. Apply/undo intents bubble up to the App, which
 * owns the controller calls and the working plan.
 */
function StitchStage({
  store,
  plan,
  tables,
  duckDBService,
  onChangeAnchor,
  onChangeJoinKey,
  onApply,
  onCancel,
}: StitchStageProps) {
  const { stitchedTable, fanOut } = useStitchStore(store)
  const applied = stitchedTable !== null

  return (
    <div className="lab-stitch__join">
      <JoinControls
        plan={plan}
        tables={tables as readonly JoinControlsTable[]}
        fanOut={fanOut}
        applied={applied}
        onChangeAnchor={onChangeAnchor}
        onChangeJoinKey={onChangeJoinKey}
        onApply={onApply}
        onCancel={onCancel}
      />
      {stitchedTable !== null ? (
        <section
          className="lab-stitch__result"
          aria-label="Stitched result preview"
        >
          <h3 className="lab-stitch__result-title">Stitched result</h3>
          <TablePreviewRegion
            tables={[stitchedTable]}
            duckDBService={duckDBService}
          />
        </section>
      ) : null}
    </div>
  )
}

export default App
