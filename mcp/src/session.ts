/**
 * The MCP session: one in-memory DuckDB, the intake and stitch stores, and the
 * existing controllers. Created lazily; discarded when the process ends.
 */
import * as path from "node:path";
import { IntakeStore } from "../../src/state/intake-store";
import { dropAllTables } from "../../src/core/chat/reset-lab";
import { createIntakeController } from "../../src/core/intake-controller";
import { createStitchController } from "../../src/core/stitching/stitch-controller";
import { StitchStore } from "../../src/core/stitching/stitch-store";
import type { StitchController } from "../../src/core/stitching/types";
import type { DuckDBService, IntakeController, LoadedTable } from "../../src/core/types";
import { createNodeDuckDB, type NodeDuckDB } from "./node-duckdb";
import { createPathGuard, type PathGuard } from "./path-guard";
import { MCP_DEFAULT_OUTPUT_DIR } from "./limits";

export interface SessionOptions {
  /** Allowed root. Default: FRANKENDATA_MCP_ROOT or the working directory. */
  root?: string;
  /** Output folder inside the root. Default: ./frankendata-output. */
  outputDir?: string;
}

export interface Session {
  guard(): Promise<PathGuard>;
  db(): Promise<DuckDBService>;
  intake: IntakeStore;
  stitchStore: StitchStore;
  /** Optional table subset for proposals (null = all loaded tables). */
  selection: { names: string[] | null };
  intakeController(): Promise<IntakeController>;
  stitchController(): Promise<StitchController>;
  tables(): readonly LoadedTable[];
  /** Serialize work: the node DuckDB instance is single threaded. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  reset(): Promise<string[]>;
  dispose(): void;
}

export function createSession(options: SessionOptions = {}): Session {
  const root = path.resolve(
    options.root ?? process.env.FRANKENDATA_MCP_ROOT ?? process.cwd()
  );
  const outputDir = options.outputDir ?? MCP_DEFAULT_OUTPUT_DIR;
  const intake = new IntakeStore();
  const stitchStore = new StitchStore();
  const selection: { names: string[] | null } = { names: null };
  let guardPromise: Promise<PathGuard> | null = null;
  let duck: Promise<NodeDuckDB> | null = null;
  let intakeCtl: IntakeController | null = null;
  let stitchCtl: StitchController | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const getDuck = (): Promise<NodeDuckDB> => (duck ??= createNodeDuckDB());
  const db = async (): Promise<DuckDBService> => (await getDuck()).service;

  return {
    guard: () => (guardPromise ??= createPathGuard({ root, outputDir })),
    db,
    intake,
    stitchStore,
    selection,
    tables: () => intake.getState().tables,
    async intakeController() {
      if (intakeCtl === null) {
        intakeCtl = createIntakeController({ duckDBService: await db(), store: intake });
      }
      return intakeCtl;
    },
    async stitchController() {
      if (stitchCtl === null) {
        stitchCtl = createStitchController({
          db: await db(),
          getTables: () => intake.getState().tables,
          store: stitchStore,
          selectTable: (t) =>
            selection.names === null || selection.names.includes(t.tableName),
        });
      }
      return stitchCtl;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(fn, fn);
      chain = next.catch(() => undefined);
      return next;
    },
    async reset() {
      const service = await db();
      try {
        await (await this.stitchController()).undo();
      } catch {
        /* nothing applied */
      }
      const dropped = await dropAllTables(service);
      stitchStore.reset();
      intake.reset();
      selection.names = null;
      return dropped;
    },
    dispose() {
      void duck?.then((d) => d.dispose()).catch(() => undefined);
    },
  };
}
