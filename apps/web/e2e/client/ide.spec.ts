import { test, expect, bootDemo, MORTALITY } from '../fixtures'

// Python and R are left out: they boot Pyodide / webR, a download of tens of MB
// per run that would dominate the suite.
test('the IDE runs the demo SQL script on the database and shows its rows', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/ide`)
  await page.getByRole('button', { name: /^03_example\.sql/ }).click()
  await expect(page.getByRole('button', { name: 'MIMIC-IV Demo' })).toBeVisible()
  await page.getByRole('button', { name: 'Run', exact: true }).click()

  // The script's last statement: 111 first ICU stays of 90 patients, 15 deaths.
  // n_deaths is a SUM, a 128-bit integer in DuckDB: it must read as a number.
  await expect(page.getByText('1 rows', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('row', { name: /^1 111 90 15 13\.5 / })).toBeVisible()
})
