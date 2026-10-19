import { test, expect, bootDemo, DEMO_WS } from '../fixtures'

test('the demo ETL pipeline shows its scripts and runs one against its source', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${DEMO_WS}/warehouse/etl`)
  await page.getByText('MIMIC-IV Demo → OMOP CDM', { exact: true }).click()
  await page.getByRole('tab', { name: 'Scripts' }).click()

  // The scripts arrive with their SQL, not as empty files.
  await page.getByRole('button', { name: /^10_src_core\.sql/ }).first().click()
  await expect(page.getByText('10_src_core : snapshots of patients', { exact: false })).toBeVisible()

  // `source.` is the pipeline's source role, resolved to the MIMIC-IV Demo database.
  // Run executes the saved script, so the edit is saved first, as a user would.
  await page.getByRole('button', { name: /^91_cdm_source\.sql/ }).first().click()
  await expect(page.getByText('91_cdm_source : CDM cdm_source', { exact: false })).toBeVisible()
  // Ctrl, not Cmd, on every host: the Desktop Chrome device reports Windows, and
  // the editor binds its shortcuts by the user agent.
  await page.getByRole('textbox', { name: 'Editor content' }).focus()
  await page.keyboard.press('Control+a')
  // Inserted rather than typed: typing lets the completion popup take keystrokes.
  await page.keyboard.insertText('SELECT gender, count(*) AS patients FROM source.hosp.patients GROUP BY gender ORDER BY gender')
  await expect(page.getByText('91_cdm_source : CDM cdm_source', { exact: false })).toHaveCount(0)
  await page.keyboard.press('Control+s')
  await page.getByRole('button', { name: 'Run', exact: true }).click()

  await expect(page.getByRole('row', { name: '1 F 43' })).toBeVisible()
  await expect(page.getByRole('row', { name: '2 M 57' })).toBeVisible()
})
