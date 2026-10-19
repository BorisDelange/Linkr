import { test, expect, bootDemo, DEMO_WS, MORTALITY } from '../fixtures'

test.beforeEach(async ({ page }) => bootDemo(page))

test('the workspace lists its databases, the demo one connected', async ({ page }) => {
  await page.goto(`${DEMO_WS}/warehouse/databases`)
  const demo = page.getByRole('button', { name: /^MIMIC-IV Demo Connected/ })
  await expect(demo).toBeVisible()
  await expect(demo).toContainText('100 patients')
  await expect(page.getByRole('button', { name: /^MIMIC-IV Demo OMOP/ })).toBeVisible()
})

test('a concept search finds a concept with its counts', async ({ page }) => {
  await page.goto(`${MORTALITY}/warehouse/concepts`)
  await page.getByPlaceholder('Search concepts (name, code or ID)…').fill('heart rate')
  await page.keyboard.press('Enter')
  const row = page.getByRole('row', { name: /220045 Heart Rate/ })
  await expect(row).toBeVisible()
  await expect(row.getByRole('cell').nth(4)).toHaveText('100')
})
