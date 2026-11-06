import { test, expect, bootDemo, ACTIVITY } from '../fixtures'

// Rows are keyed by column id in the browser; SpcComponent looks them up by name, so
// the client build never finds a value and always answers "Not enough data".
test('a control chart added to a dashboard draws its chart @known-bug', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${ACTIVITY}/lab/dashboards`)
  await page.getByText('ICU Activity', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Add widget' }).first().click()

  const dialog = page.getByRole('dialog')
  await dialog.getByText('Control chart (SPC)').click()
  await dialog.getByRole('button', { name: 'None' }).first().click()
  await page.getByRole('button', { name: 'unit_admission_datetime date' }).click()
  // The first picker's list closes with an animation the second one must wait for.
  await expect(page.getByRole('button', { name: 'unit_admission_datetime date' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'None' }).first().click()
  await page.getByRole('button', { name: 'deceased_in_icu boolean' }).click()
  await dialog.getByRole('button', { name: 'Add widget' }).click()

  const main = page.locator('main main')
  await expect(main.getByText(/error/i)).toHaveCount(0)
  await expect(main.getByText('Not enough data to draw a control chart.')).toHaveCount(0)
  // The chart's axes: the periods along it, the proportion up it.
  await expect(main.getByRole('application').filter({ hasText: /\d{4}-\d{2}-\d{2}.*\d %/ })).toBeVisible()
})
