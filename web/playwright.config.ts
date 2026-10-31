import { defineConfig } from '@playwright/test'

// Browser tests of the console against a running API (at API_ADDR, as `npm run dev` proxies). `npm run pages`.
// The API must be started with PUBLIC_URL=http://localhost:5174: upload addresses are built from it.
export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000, // the main flow waits for a video to be processed
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // Its own port, so a dev server already on 5173 (this or another project) is never reused or disturbed.
  // PLAYWRIGHT_CHANNEL=chrome uses an installed Chrome instead of Playwright's own download.
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL },
  webServer: { command: 'npm run dev -- --port 5174 --strictPort', url: 'http://localhost:5174', reuseExistingServer: false, timeout: 120_000 },
})
