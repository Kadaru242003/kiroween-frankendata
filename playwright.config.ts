import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run in a real browser against the Vite dev server. They are
// NOT part of `npm test` (Vitest only includes src, api and mcp). Run them with
// `npm run test:e2e` after `npx playwright install chromium`.
const PORT = 5199

// E2E_SLOWMO=600 npm run test:e2e -- --headed runs at a watchable speed.
// Unset or not a positive integer: no slow motion (the default stays fast).
const parsedSlowMo = Number.parseInt(process.env.E2E_SLOWMO ?? '', 10)
const slowMo = Number.isFinite(parsedSlowMo) && parsedSlowMo > 0 ? parsedSlowMo : 0

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
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { slowMo } },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
