import { test, expect, bootDemo, MORTALITY } from '../fixtures'

test('a saved cohort runs and describes its unit stays', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/warehouse/cohorts`)
  await page.getByRole('button', { name: /Example cohort/ }).click()
  await page.getByRole('button', { name: 'Run query' }).first().click()
  // Women aged 50 and over, one row per unit stay, on the MIMIC-IV demo.
  await expect(page.getByText('unit stays', { exact: true }).first()).toBeVisible()
  // The Statistics tab opens first, on the report's figures.
  await expect(page.getByText('Mortality', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/^Female · .* \(100 %\)$/)).toBeVisible()
  await expect(page.getByText(/^Male · /)).toHaveCount(0)
  await expect(page.getByText('Age distribution (at index date)')).toBeVisible()
})
