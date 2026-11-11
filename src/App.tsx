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
import { createProxyAiProvider } from './core/stitching/ai-provider'
import type { StitchController, StitchPlan } from './core/stitching/types'
import { useStitchStore } from './core/stitching/stitch-store'
import {
  ApprovalScreen,
  type ApprovalScreenTable,
} from './components/stitching/ApprovalScreen'
import {
  StitchEntryPoint,
  shouldShowStitchEntry,
  canStartStitching,
} from './components/stitching/StitchEntryPoint'
import {
  selectedTableNames as computeSelectedTableNames,
  pruneUnchecked,
  toggleUnchecked,
} from './components/stitching/table-selection'
import {
  JoinControls,
  type JoinControlsTable,
} from './components/stitching/JoinControls'
import {
  createAskController,
  type AskController,
} from './core/chat/ask-controller'
import { createDuckDbQueryRunner } from './core/chat/query-runner'
import {
  createDemoLoader,
  type DemoLoader,
  type DemoId,
} from './core/chat/demo-loader'
import { dropAllTables } from './core/chat/reset-lab'
import { buildQueryableTables } from './core/chat/queryable-tables'
import { generateStarterChips, type StarterChip } from './core/chat/starter-questions'
import { createProxySqlProvider } from './core/chat/sql-provider'
import {
  buildSchemaSummary,
  type SchemaSourceTable,
} from './core/chat/schema-builder'
import { createSampleReader } from './core/stitching/sample-reader'
import type { QueryableTable } from './core/chat/types'
import { AskStore } from './state/ask-store'
import { AskTheLabPanel } from './components/chat/AskTheLabPanel'
import './App.css'

/**
 * Whether the LLM path is available to "Ask the Lab". The production
 * SqlProvider (ProxySqlProvider → `/api/sql`) is wired in task 9; until then no
 * provider is passed, so free-form questions resolve to "AI unavailable" with
 * NO network request regardless of the flag. The flag is still read so the UI
 * note is accurate once the provider lands.
 */
const ASK_AI_AVAILABLE = import.meta.env.VITE_AI_ENABLED === 'true'

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
  /** The "Ask the Lab" controller, wired to the real DuckDB QueryRunner. */
  askController: AskController
  /** Session-only state for the Ask the Lab panel (history + outcome). */
  askStore: AskStore
  /** Idempotent demo loader (one load per demo id until reset). */
  demoLoader: DemoLoader
}

/**
 * The names of the tables "Ask the Lab" may currently query, held at module
 * scope so the {@link AskController}'s `getQueryableTableNames` — built once in
 * {@link getLabStack} — always reads the latest set the App maintains in React
 * state (the live intake tables plus the present `stitch_*` tables). Starts
 * empty; the panel region keeps it in sync.
 */
let queryableTableNamesHolder: readonly string[] = []

/**
 * The current queryable tables WITH their row counts, used by the Ask the Lab
 * schema builder (the LLM path). Kept in sync by the panel region alongside
 * {@link queryableTableNamesHolder}. Empty until the first refresh.
 */
let queryableSchemaSourceHolder: readonly SchemaSourceTable[] = []

/**
 * Module-level singleton promise for initializing the DuckDB service and
 * building the controller. React StrictMode mounts effects twice in dev;
 * caching the promise here guarantees `init()` runs — and a single in-memory
 * DuckDB instance is created — exactly once regardless of how many times the
 * effect fires.
 */
let labStackPromise: Promise<LabStack> | null = null

/**
 * The set of table names currently CHECKED for stitching (polish batch 2,
 * item 1). Held at module scope so the controller's `selectTable` filter —
 * built once inside {@link getLabStack} — always reads the latest selection
 * the App (React state) maintains. `null` means "not yet initialized": every
 * loaded table participates until the App seeds the set.
 */
let selectedTableNamesHolder: ReadonlySet<string> | null = null

/** `true` when a table participates in stitching (default: yes, when unseeded). */
function isTableSelectedForStitching(tableName: string): boolean {
  return (
    selectedTableNamesHolder === null ||
    selectedTableNamesHolder.has(tableName)
  )
}

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
      // the live loaded-table set from the intake store.
      //
      // AI wiring (task 22): the production ProxyAiProvider talks to the
      // same-origin `/api/ai` serverless proxy, gated by the VITE_AI_ENABLED
      // build-time flag. With the flag unset or "false" (the default, and the
      // only possibility under `vite dev` where `/api/ai` does not exist), the
      // controller runs rules-only and NEVER attempts a network call — it
      // short-circuits on the flag before ever touching the provider. With the
      // flag "true" it calls the ProxyAiProvider, and any failure (timeout,
      // non-200, network error, invalid body) falls back to the rules result.
      const stitchStore = new StitchStore()
      const getTables: LoadedTablesProvider = () =>
        intakeStore.getState().tables
      const stitchController = createStitchController({
        db: duckDBService,
        getTables,
        store: stitchStore,
        aiProvider: createProxyAiProvider(),
        aiEnabledFlag: import.meta.env.VITE_AI_ENABLED,
        // Only the CHECKED tables participate (item 1). The filter reads the
        // module-level selection the App keeps in sync with its React state.
        selectTable: (t) => isTableSelectedForStitching(t.tableName),
      })
      // Feature 3 "Ask the Lab" stack, wired to the SAME DuckDB instance via a
      // real QueryRunner. No SqlProvider is passed yet (ProxySqlProvider is
      // task 9), so `ask` resolves to `ai-unavailable` for free-form questions
      // and never makes a network call; starter chips run directly.
      const askStore = new AskStore()
      // The real QueryRunner (extracted to src/core/chat/query-runner.ts) runs
      // the SQL and asks DuckDB for the result column types, so DATE/TIMESTAMP
      // values render as readable ISO strings instead of raw epoch ms.
      const runQuery = createDuckDbQueryRunner(duckDBService)
      // The LLM path is wired ONLY when VITE_AI_ENABLED === "true": the
      // ProxySqlProvider posts to the same-origin `/api/sql`, and the schema
      // builder reads bounded samples via the Feature 2 SampleReader. With the
      // flag off, no provider/buildSchema is passed, so `ask` returns
      // `ai-unavailable` and never makes a network call (the AI-off path).
      const sampleReader = createSampleReader(duckDBService)
      const askController = createAskController({
        getQueryableTableNames: () => [...queryableTableNamesHolder],
        runQuery,
        aiEnabled: ASK_AI_AVAILABLE,
        provider: ASK_AI_AVAILABLE ? createProxySqlProvider() : undefined,
        buildSchema: ASK_AI_AVAILABLE
          ? () => buildSchemaSummary(sampleReader, [...queryableSchemaSourceHolder])
          : undefined,
      })

      // Idempotent demo loading: each demo loads once (by id) until reset, so
      // repeated clicks never pile up monsters_2, monsters_3, … copies.
      const demoLoader = createDemoLoader({
        providers: {
          default: () => demoDataLoader.load(),
          mismatched: () => demoDataLoader.loadMismatched(),
        },
        intake: (files) => controller.intake(files),
      })

      return {
        duckDBService,
        controller,
        stitchStore,
        stitchController,
        askController,
        askStore,
        demoLoader,
      }
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
  // Stitching table selection (item 1). We track the names the user has
  // EXPLICITLY UNCHECKED rather than the checked set: a table is checked iff
  // it is loaded and NOT in this set. This makes "all tables checked by
  // default, including ones loaded later" the natural zero-state (an empty
  // set) with no per-arrival bookkeeping — so it is robust under React
  // StrictMode's double effect invocation (the old `seen`-set effect could
  // misfire and leave freshly-loaded tables unchecked).
  const [uncheckedTableNames, setUncheckedTableNames] = useState<
    ReadonlySet<string>
  >(() => new Set())
  // Which demos are currently loaded (by id), mirrored from the demo loader so
  // each demo's button shows an "Already loaded" state and loads only once.
  const [loadedDemos, setLoadedDemos] = useState<ReadonlySet<DemoId>>(
    () => new Set(),
  )

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

  // Prune unchecked entries whose table is no longer loaded, so a removed-
  // then-reloaded table comes back checked. This is idempotent, so running
  // it twice under StrictMode is harmless.
  useEffect(() => {
    const loadedNames = tables.map((t) => t.tableName)
    setUncheckedTableNames((prev) => pruneUnchecked(prev, loadedNames))
  }, [tables])

  // Mirror the derived checked set to the module-level holder the
  // controller's selectTable filter reads. Keyed on the stable sorted name
  // list so it only updates when the checked membership actually changes.
  const selectedNamesKey = tables
    .map((t) => t.tableName)
    .filter((name) => !uncheckedTableNames.has(name))
    .sort()
    .join('\u0000')
  useEffect(() => {
    selectedTableNamesHolder = new Set(
      selectedNamesKey.length === 0 ? [] : selectedNamesKey.split('\u0000'),
    )
  }, [selectedNamesKey])

  const handleFiles = useCallback(
    (files: File[]) => {
      if (stack === null || files.length === 0) {
        return
      }
      void stack.controller.intake(files)
    },
    [stack],
  )

  // Load a demo ONCE by id (idempotent). A repeated click is a no-op; the
  // button reflects "Already loaded" via `loadedDemos`. Loading the other demo
  // is always allowed. Reset re-enables both (see handleResetLab).
  const loadDemo = useCallback(
    async (id: DemoId) => {
      if (stack === null) {
        return
      }
      const didLoad = await stack.demoLoader.load(id)
      if (didLoad) {
        setLoadedDemos((prev) => {
          const next = new Set(prev)
          next.add(id)
          return next
        })
      }
    },
    [stack],
  )

  const handleLoadDemo = useCallback(() => loadDemo('default'), [loadDemo])
  // The second, mismatched dataset (Req 8.1–8.4) routes through the SAME intake
  // pipeline; its two files make the stitching stage reachable (Req 8.4).
  const handleLoadMismatchedDemo = useCallback(
    () => loadDemo('mismatched'),
    [loadDemo],
  )

  // Reset the whole lab: drop every DuckDB table (originals, cleaned copies,
  // stitch results), clear the intake store, stitch state + undo, the Ask the
  // Lab history/outcome, and re-enable the demo buttons. Never throws, even if
  // DuckDB is mid-operation or a drop fails. No confirm dialog.
  const handleResetLab = useCallback(async () => {
    if (stack === null) {
      return
    }
    // Best-effort undo of any applied stitch (drops its created tables), then a
    // belt-and-braces drop of every remaining base table.
    try {
      await stack.stitchController.undo()
    } catch {
      /* non-fatal */
    }
    try {
      await dropAllTables(stack.duckDBService)
    } catch {
      /* dropAllTables already never throws; guard anyway */
    }
    stack.stitchStore.reset()
    stack.askStore.reset()
    stack.demoLoader.clear()
    intakeStore.reset()
    // Reset local React view state so no stale selection/plan/demo flags linger.
    setLoadedDemos(new Set())
    setUncheckedTableNames(new Set())
    setWorkingPlan(null)
    setStitchOpen(false)
    queryableTableNamesHolder = []
    queryableSchemaSourceHolder = []
  }, [stack])

  const canStitch = shouldShowStitchEntry(tables.length)
  // The subset of loaded tables CHECKED for stitching: loaded minus the
  // explicitly-unchecked set (item 1). Used by the entry-point checkboxes,
  // the enable rule, and to scope the approval UI's re-pair targets / anchor
  // options to what the controller proposed over.
  const selectedTables = tables.filter(
    (t) => !uncheckedTableNames.has(t.tableName),
  )
  const selectedTableNames: ReadonlySet<string> = computeSelectedTableNames(
    tables.map((t) => t.tableName),
    uncheckedTableNames,
  )
  const selectedCount = selectedTables.length
  const canStartStitch = canStartStitching(selectedCount)

  // Toggle a table's participation in stitching (item 1). Checking removes
  // the name from the unchecked set; unchecking adds it.
  const handleToggleTable = useCallback(
    (tableName: string, checked: boolean) => {
      setUncheckedTableNames((prev) =>
        toggleUnchecked(prev, tableName, checked),
      )
    },
    [],
  )

  // Opening the stitch screen computes proposals for the CHECKED table set
  // (rules-only). Any compute failure is swallowed — the screen simply shows an
  // empty state rather than crashing the lab.
  const handleOpenStitch = useCallback(() => {
    if (stack === null || !canStartStitch) {
      return
    }
    setStitchOpen(true)
    void stack.stitchController.computeProposals().catch(() => {
      // Non-fatal: leave the screen open with whatever (possibly empty) state
      // the store holds.
    })
  }, [stack, canStartStitch])

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
            <div className="lab-intake__demos">
              <DemoDataControl
                onLoadDemo={handleLoadDemo}
                caption="Three messy lab files, typed automatically"
                alreadyLoaded={loadedDemos.has('default')}
              />
              {/*
                Second demo action: the mismatched stitching dataset (Req 8.4).
                Routes through the identical intake pipeline; its two tables make
                the stitching stage reachable.
              */}
              <DemoDataControl
                onLoadDemo={handleLoadMismatchedDemo}
                label={LOAD_MISMATCHED_DEMO_LABEL}
                caption="Two files with different headers, ready to stitch"
                alreadyLoaded={loadedDemos.has('mismatched')}
              />
            </div>
            {/*
              Reset lab: shown only when at least one table is loaded. Drops all
              DuckDB tables, clears every store + undo + the ask panel, and
              re-enables the demo buttons. No confirm dialog; never throws.
            */}
            {tables.length > 0 ? (
              <button
                type="button"
                className="lab-reset__button"
                onClick={() => void handleResetLab()}
              >
                Reset lab
              </button>
            ) : null}
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
              tables={tables}
              selectedTableNames={selectedTableNames}
              onToggleTable={handleToggleTable}
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
                tables={selectedTables as readonly ApprovalScreenTable[]}
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
                  tables={selectedTables}
                  duckDBService={status.stack.duckDBService}
                  onChangeAnchor={handleChangeAnchor}
                  onChangeJoinKey={handleChangeJoinKey}
                  onApply={handleApplyPlan}
                  onCancel={handleUndoStitch}
                />
              ) : null}
            </section>
          ) : null}

          {/*
            Ask the Lab panel: rendered below the stitching UI, shown only when
            at least one queryable table exists (Req 1.1). It refreshes its
            queryable-table list + starter chips when the loaded tables change
            or a stitch is applied/undone (keyed on the stitched table).
          */}
          <AskPanelRegion
            loadedTables={tables}
            duckDBService={status.stack.duckDBService}
            askController={status.stack.askController}
            askStore={status.stack.askStore}
            stitchStore={status.stack.stitchStore}
          />

          <TablePreviewRegion
            tables={tables}
            duckDBService={status.stack.duckDBService}
          />
        </>
      ) : null}
    </main>
  )
}

/** Props for {@link AskPanelRegion}. */
interface AskPanelRegionProps {
  loadedTables: readonly LoadedTable[]
  duckDBService: DuckDBService
  askController: AskController
  askStore: AskStore
  stitchStore: StitchStore
}

/**
 * Builds the queryable-table list (intake tables + present `stitch_*` tables)
 * and the deterministic starter chips, keeping them in sync as tables change
 * or a stitch is applied/undone, then renders {@link AskTheLabPanel} once at
 * least one queryable table exists (Req 1.1).
 *
 * The queryable table NAMES are mirrored into the module-level holder the
 * AskController reads, so the SqlValidator always allowlists the current set.
 */
function AskPanelRegion({
  loadedTables,
  duckDBService,
  askController,
  askStore,
  stitchStore,
}: AskPanelRegionProps) {
  const [queryable, setQueryable] = useState<QueryableTable[]>([])
  const [chips, setChips] = useState<StarterChip[]>([])
  // The applied stitched table (or null) — changes on apply/undo and triggers
  // a refresh so stitch_* tables enter/leave the queryable set.
  const { stitchedTable } = useStitchStore(stitchStore)
  const runIdRef = useRef(0)

  useEffect(() => {
    const runId = ++runIdRef.current
    let cancelled = false
    void (async () => {
      try {
        const tables = await buildQueryableTables(duckDBService, loadedTables)
        const generated = await generateStarterChips(duckDBService, tables)
        // Row counts for the schema builder (LLM path). Intake tables carry a
        // known count; stitch_* tables are counted via DuckDB. A count failure
        // defaults to 0, which only affects sample budgeting, not safety.
        const loadedCounts = new Map(
          loadedTables.map((t) => [t.tableName, t.rowCount]),
        )
        const schemaSources: SchemaSourceTable[] = await Promise.all(
          tables.map(async (t) => {
            let rowCount = loadedCounts.get(t.tableName) ?? 0
            if (!loadedCounts.has(t.tableName)) {
              try {
                rowCount = await duckDBService.getRowCount(t.tableName)
              } catch {
                rowCount = 0
              }
            }
            return { ...t, rowCount }
          }),
        )
        if (cancelled || runId !== runIdRef.current) return
        queryableTableNamesHolder = tables.map((t) => t.tableName)
        queryableSchemaSourceHolder = schemaSources
        setQueryable(tables)
        setChips(generated)
      } catch {
        // A refresh failure must not break the lab; keep the prior view.
      }
    })()
    return () => {
      cancelled = true
    }
    // `stitchedTable` is a refresh trigger (apply/undo); loadedTables covers
    // intake changes.
  }, [loadedTables, duckDBService, stitchedTable])

  // Keep the outcome fresh: if the queryable set empties, clear any stale
  // outcome so the (now-hidden) panel does not retain old results.
  useEffect(() => {
    if (queryable.length === 0) askStore.clearOutcome()
  }, [queryable.length, askStore])

  if (queryable.length === 0) return null

  return (
    <section className="lab-ask" aria-label="Ask the Lab">
      <AskTheLabPanel
        controller={askController}
        store={askStore}
        chips={chips}
        aiAvailable={ASK_AI_AVAILABLE}
      />
    </section>
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
