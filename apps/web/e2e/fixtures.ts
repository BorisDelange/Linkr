import { test as base, expect, type Page } from '@playwright/test'

/**
 * Every journey fails on an uncaught exception in the page, even when the screen
 * looked right: several boot bugs only ever announced themselves there.
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await use(errors)
      expect(errors, 'uncaught exceptions in the page').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

export const DEMO_WS = '/workspaces/seed-default'
export const MORTALITY = `${DEMO_WS}/projects/icu-mortality-prediction`
export const ACTIVITY = `${DEMO_WS}/projects/icu-activity-dashboard`

/** Opens the app and waits until the demo is seeded and the status bar says so. */
export async function bootDemo(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 90_000 })
}

/** The administrator the server journeys create on a fresh instance (server/first-run.spec.ts). */
export const ADMIN = { username: 'e2e-admin', password: 'e2e-journey-password-2026' }

/** Signs the administrator in on a server instance whose first run is done. */
export async function signIn(page: Page) {
  await page.goto('./')
  await page.getByLabel('Username').fill(ADMIN.username)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible()
}
