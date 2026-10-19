import { test, expect, bootDemo, MORTALITY } from '../fixtures'

test('a saved cohort runs and lists its unit stays', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/warehouse/cohorts`)
  await page.getByRole('button', { name: /Example cohort/ }).click()
  await page.getByRole('button', { name: 'Run query' }).first().click()
  // Women aged 50 and over, one row per unit stay, on the MIMIC-IV demo.
  await expect(page.getByText('results', { exact: true })).toBeVisible()
  await expect(page.getByRole('row', { name: /Female/ }).first()).toBeVisible()
  await expect(page.getByRole('row', { name: / Male / })).toHaveCount(0)
})
