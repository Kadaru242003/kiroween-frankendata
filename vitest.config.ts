import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Vitest configuration for FrankenData.
// - jsdom environment so React component tests can render against a DOM.
// - a setup file wires up @testing-library/jest-dom matchers.
// - globals enabled so describe/it/expect are available without imports.
// The `test` npm script runs `vitest --run` for a single execution (no watch).
//
// fileParallelism is disabled on purpose. Many tests (the DuckDB-backed
// property/smoke tests) each instantiate the DuckDB-WASM *node-blocking*
// emscripten bundle. That native WebAssembly module is not safe to run
// concurrently across Vitest's worker threads: under parallel execution its
// emscripten runtime intermittently wedges — surfacing as the non-deterministic
// `ReferenceError: _setThrew is not defined` the first time an apply SQL throws
// — and the heavier DuckDB property files occasionally blow the default 5s
// test timeout purely from CPU contention. Both are test-runner contention
// artifacts, NOT production-logic bugs (the applier only ever touches
// `stitch_`-prefixed copies). Running test files one at a time keeps a single
// DuckDB-WASM instance resident at a time and makes the suite reliably green,
// while every property test still runs its full fast-check iteration count.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Serialize test files (see note above) to remove DuckDB-WASM worker-thread
    // contention. Tests within a file still run exactly as written.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
