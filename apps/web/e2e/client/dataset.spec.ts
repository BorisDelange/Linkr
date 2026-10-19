import { test, expect, bootDemo, MORTALITY } from '../fixtures'

test('a project dataset opens as a table', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/lab/datasets`)
  await page.getByText('mortality_dataset.csv', { exact: true }).click()
  await expect(page.getByRole('columnheader', { name: /in_hospital_death/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /heart_rate_max/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /^1 34577403 10003400 23559586 72 F / })).toBeVisible()
})
