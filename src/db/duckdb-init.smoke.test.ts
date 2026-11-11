// DuckDB-WASM initialization smoke test (Task 1.2).
//
// Purpose: prove the foundational @duckdb/duckdb-wasm integration works before
// any real logic is built — a single in-memory instance can be created, a
// trivial query runs, and the instance has no persistent backing store
// (Requirements 8.1, 11.2).
//
// Environment note:
// DuckDB-WASM ships several bundles. The *browser* bundles load the Wasm module
// and a worker over URLs/fetch and expect a real browser worker environment,
// which is not available under Vitest's jsdom/node runner. This smoke test
// therefore uses the *node* bundle (`duckdb-node-blocking`), pointing it at the
// Wasm module and node worker files that ship inside the installed package. The
// node bundle exercises the exact same DuckDB engine over WebAssembly; it only
// differs in how the Wasm/worker assets are located, which is precisely the part
// that has to be adapted for a non-browser test runner. The application's real
// DuckDBService (task 10.1) uses the browser bundle at runtime.

import { createRequire } from 'node:module'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// Resolve the installed DuckDB-WASM dist assets from this package. Using
// createRequire keeps resolution working under Vitest's ESM transform.
const require = createRequire(import.meta.url)

// The node-blocking bundle gives us a synchronous query API, which keeps the
// smoke test simple and deterministic.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs') as {
  createDuckDB: (bundles: unknown, logger: unknown, runtime: unknown) => Promise<DuckDBNodeInstance>
  NODE_RUNTIME: unknown
  VoidLogger: new () => unknown
  DuckDBAccessMode: { READ_WRITE: number }
}

interface DuckDBConnectionLike {
  query(text: string): { toArray(): Array<{ toJSON(): Record<string, unknown> }> }
  close(): void
}

interface DuckDBNodeInstance {
  instantiate(): Promise<unknown>
  open(config: { path?: string; accessMode?: number }): void
  connect(): DuckDBConnectionLike
  getVersion(): string
  reset(): void
}

// Directory that contains the shipped Wasm module and the node worker script.
const DUCKDB_DIST = path.dirname(
  require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'),
)

// MVP bundle: the baseline WebAssembly target that runs everywhere, including
// the node worker used by Vitest.
const bundles = {
  mvp: {
    mainModule: path.join(DUCKDB_DIST, 'duckdb-mvp.wasm'),
    mainWorker: path.join(DUCKDB_DIST, 'duckdb-node-mvp.worker.cjs'),
  },
}

async function createInMemoryDuckDB(): Promise<DuckDBNodeInstance> {
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME)
  await db.instantiate()
  // ':memory:' = in-memory database with no persistent backing store (Req 8.1).
  db.open({ path: ':memory:', accessMode: duckdb.DuckDBAccessMode.READ_WRITE })
  return db
}

describe('DuckDB-WASM initialization smoke test', () => {
  it('creates a single instance and runs a trivial query (SELECT 1)', async () => {
    const db = await createInMemoryDuckDB()
    try {
      expect(db.getVersion()).toMatch(/^v?\d+\.\d+/)

      const conn = db.connect()
      try {
        const rows = conn.query('SELECT 1 AS value').toArray().map((r) => r.toJSON())
        expect(rows).toHaveLength(1)
        expect(Number(rows[0].value)).toBe(1)
      } finally {
        conn.close()
      }
    } finally {
      db.reset()
    }
  })

  it('operates in-memory with no persistent backing store', async () => {
    const db = await createInMemoryDuckDB()
    try {
      const conn = db.connect()
      try {
        // The current database is the in-memory catalog, not a file on disk.
        // DuckDB reports the in-memory database as "memory".
        const dbRows = conn
          .query('SELECT current_database() AS db')
          .toArray()
          .map((r) => r.toJSON())
        expect(dbRows[0].db).toBe('memory')

        // No attached database points at a persistent file path: every attached
        // database's file is either empty or the in-memory marker.
        const attached = conn
          .query('SELECT database_name, path FROM duckdb_databases()')
          .toArray()
          .map((r) => r.toJSON() as { database_name: string; path: string | null })

        for (const entry of attached) {
          const filePath = entry.path ?? ''
          expect(filePath === '' || filePath === ':memory:').toBe(true)
        }

        // Data written in this session lives only in memory for the connection's
        // lifetime; creating and reading a table round-trips without any file I/O.
        conn.query('CREATE TABLE smoke AS SELECT 42 AS answer')
        const tableRows = conn
          .query('SELECT answer FROM smoke')
          .toArray()
          .map((r) => r.toJSON())
        expect(Number(tableRows[0].answer)).toBe(42)
      } finally {
        conn.close()
      }
    } finally {
      db.reset()
    }

    // jsdom provides no IndexedDB, confirming nothing was persisted to a browser
    // store during initialization.
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined()
  })
})
