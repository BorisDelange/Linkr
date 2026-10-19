import { test, expect, bootDemo } from '../fixtures'

test('a first visit seeds the demo and lands on the home page', async ({ page }) => {
  await bootDemo(page)
  await expect(page.getByRole('heading', { name: 'Healthcare data science, simplified.' })).toBeVisible()
  await expect(page.getByText('Demo workspace')).toBeVisible()
})

test('a deep link to a warehouse page works on a cold start', async ({ page }) => {
  // Straight to a page that mounts a database, without passing through Home:
  // what exercises the mount-race guards (lib/duckdb/engine.ts).
  await page.goto('/workspaces/seed-default/projects/icu-mortality-prediction/warehouse/concepts')
  await expect(page.getByRole('table').getByRole('row').nth(2)).toBeVisible({ timeout: 90_000 })
})
