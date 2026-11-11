import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Vitest configuration for FrankenData.
// - jsdom environment so React component tests can render against a DOM.
// - a setup file wires up @testing-library/jest-dom matchers.
// - globals enabled so describe/it/expect are available without imports.
// The `test` npm script runs `vitest --run` for a single execution (no watch).
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
