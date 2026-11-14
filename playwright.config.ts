import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run in a real browser against the Vite dev server. They are
// NOT part of `npm test` (Vitest only includes src, api and mcp). Run them with
// `npm run test:e2e` after `npx playwright install chromium`.
const PORT = 5199

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
