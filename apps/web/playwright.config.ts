import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end journeys in a real browser (docs/testing.md § End-to-end).
 *
 * - `client`: the client-only (WASM) build with the demo seed, served by
 *   `vite preview` on E2E_PORT. Set E2E_BASE_URL to test a build already served,
 *   E2E_SKIP_BUILD=1 to serve the existing dist/ without rebuilding (and to reuse
 *   a preview already listening on that port). Without it the port must be free:
 *   reusing whatever answers there could test another worktree's or an older build.
 * - `server`: a running full stack (dev:all, or the SPE simulation's gateway),
 *   named by E2E_SERVER_URL. Skipped when unset. Its `server-setup` dependency
 *   creates the first account, so point it at a fresh, disposable instance.
 */
const port = Number(process.env.E2E_PORT) || defaultE2ePort()
const clientUrl = process.env.E2E_BASE_URL ?? `http://localhost:${port}`
const serverUrl = process.env.E2E_SERVER_URL

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // A cold WASM boot seeds the demo for ~20-25 s before the first page is usable.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // A journey tagged @known-bug reproduces an open bug: left out of a normal run
  // so the suite stays a signal, run on purpose with E2E_KNOWN_BUGS=1.
  grepInvert: process.env.E2E_KNOWN_BUGS ? undefined : /@known-bug/,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'client', testDir: './e2e/client', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: clientUrl } },
    // The first run creates the administrator every other server journey signs in
    // as, so it is a project of its own that `server` depends on.
    ...(serverUrl
      ? [
          { name: 'server-setup', testDir: './e2e/server', testMatch: /first-run\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: serverUrl } },
          { name: 'server', testDir: './e2e/server', testIgnore: /first-run\.spec\.ts/, dependencies: ['server-setup'], use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: serverUrl } },
          // The first run with the default data, for the versioning journeys (scripts/test-versioning.mjs).
          { name: 'server-demo-setup', testDir: './e2e/server', testMatch: /demo-install\.setup\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: serverUrl } },
        ]
      : []),
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.E2E_SKIP_BUILD
          ? `npx vite preview --port ${port} --strictPort`
          : `VITE_API_URL= npx vite build && npx vite preview --port ${port} --strictPort`,
        url: clientUrl,
        timeout: 300_000,
        reuseExistingServer: !!process.env.E2E_SKIP_BUILD && !process.env.CI,
        stdout: 'ignore',
      },
})

/**
 * 4317 in the main worktree; a worktree from `npm run worktree:new` owns a
 * WEB_PORT in 3001-3099 (its apps/web/.env.local), and gets 4317 + the same
 * offset, so two worktrees' journeys never share a port.
 */
function defaultE2ePort(): number {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env.local')
  const fromFile = existsSync(envFile)
    ? readFileSync(envFile, 'utf-8').match(/^\s*WEB_PORT\s*=\s*(\d+)/m)?.[1]
    : undefined
  const webPort = Number(process.env.WEB_PORT ?? fromFile)
  return webPort > 3000 && webPort < 3100 ? 4317 + (webPort - 3000) : 4317
}
