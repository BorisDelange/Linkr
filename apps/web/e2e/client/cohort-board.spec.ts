import { test, expect, bootDemo, MORTALITY } from '../fixtures'

test('a cohort’s patient board is generated from its criteria', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/warehouse/cohorts`)
  await page.getByRole('button', { name: /Example cohort/ }).click()
  await page.getByRole('button', { name: 'Run query' }).first().click()
  await expect(page.getByText('unit stays', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Patients', exact: true }).click()
  await page.getByRole('button', { name: 'Generate tabs' }).first().click()
  // The patient's summary first, the notes after it.
  await expect(page.getByRole('button', { name: 'Summary', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible()

  await page.getByRole('button', { name: /^\d+ [FM] / }).first().click()
  // Every read of the selected patient shows in the jobs panel, named.
  await page.getByRole('button', { name: /\d+ jobs?$/ }).click()
  await expect(page.getByText(/^Patient summary · /).first()).toBeVisible()
})

test('a data table shows a concept’s values by period', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/warehouse/patient-data`)
  await page.getByRole('button', { name: /MIMIC-IV Board example/ }).click()
  await page.getByRole('button', { name: /^10000032 / }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Add widget' }).click()
  await page.getByText('Data table', { exact: true }).click()
  await page.getByRole('button', { name: 'Select concepts' }).click()
  const picker = page.getByRole('dialog', { name: 'Select concepts' })
  await picker.getByRole('row', { name: / Heart Rate / }).first().click()
  await picker.getByRole('button', { name: 'Confirm (1)' }).click()
  // Heart rate of the patient, by period, each value with how many readings it averages.
  const preview = page.getByRole('dialog').getByRole('table')
  await expect(preview.getByRole('cell', { name: /Heart Rate/ })).toBeVisible()
  await expect(preview.locator('sub').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/datatable-preview.png' })
})
