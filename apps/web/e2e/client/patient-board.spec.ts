import { test, expect, bootDemo, MORTALITY } from '../fixtures'

test('a patient board shows the selected patient', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/warehouse/patient-data`)
  await page.getByRole('button', { name: /MIMIC-IV Board example/ }).click()
  await expect(page.getByText('Patients (100)')).toBeVisible()
  await page.getByRole('button', { name: /^10000032 / }).click()
  const summary = page.locator('main main')
  await expect(summary.getByRole('heading', { name: 'Hospitalizations' })).toBeVisible()
  await expect(summary.getByText('Select a patient first.')).toHaveCount(0)
})
