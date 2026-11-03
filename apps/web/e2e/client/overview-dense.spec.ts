import { test, expect, bootDemo, DEMO_WS, MORTALITY } from '../fixtures'

// The Data overview on patients of 1 M and 5 M events, in the browser's own
// engine, the page's CPU slowed down as on a modest laptop (CDP throttles the
// page, not DuckDB-WASM's worker: the queries' own cost is overview.perf.test.ts).
// Off unless the dense dataset is named (npm run test-data -- mimic-iv-demo-dense-5m;
// the 20 M one is too large for the browser to store):
//   OVERVIEW_DENSE_DIR=<testData.dir>/mimic-iv-demo-dense-5m OVERVIEW_CPU_THROTTLE=4 \
//     npx playwright test overview-dense --project client
const DIR = process.env.OVERVIEW_DENSE_DIR
const THROTTLE = Number(process.env.OVERVIEW_CPU_THROTTLE ?? 4)
const PATIENTS = (process.env.OVERVIEW_DENSE_PATIENTS ?? '990000002,990000003').split(',')

test.skip(!DIR, 'set OVERVIEW_DENSE_DIR to the mimic-iv-demo-dense dataset')
test.use({ actionTimeout: 30_000 })

test('the data overview draws dense patients on a slow machine', async ({ page }) => {
  test.setTimeout(1_800_000)
  // Without the directory picker, the folder zone falls back on an <input
  // webkitdirectory> the test can fill.
  await page.addInitScript(() => { delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker })
  await bootDemo(page)

  const name = `Dense ${Date.now()}`
  await page.goto(`${DEMO_WS}/warehouse/databases`)
  await page.getByRole('button', { name: 'Add database' }).click()
  await page.getByRole('menuitem', { name: 'Add connection' }).click()
  await page.getByRole('button', { name: /^Database DuckDB/ }).click()
  await page.getByPlaceholder('e.g. MIMIC-IV OMOP').fill(name)
  await page.getByRole('tab', { name: 'Connection' }).click()
  await page.getByRole('combobox').filter({ hasText: 'No schema (raw SQL access)' }).click()
  await page.getByRole('option', { name: 'OMOP CDM 5.4' }).click()
  await page.getByRole('button', { name: 'Parquet folder' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByText('Select a folder containing Parquet files').click(),
  ])
  await chooser.setFiles(DIR!)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: new RegExp(`^${name} Connected`) })).toBeVisible({ timeout: 600_000 })

  await page.goto(`${MORTALITY}/warehouse/databases`)
  await page.getByRole('button', { name: 'Link database' }).click()
  await page.getByRole('dialog').getByText(name).click()
  await page.keyboard.press('Escape')

  await page.goto(`${MORTALITY}/warehouse/patient-data`)
  await page.getByRole('button', { name: /MIMIC-IV Board example/ }).getByRole('button').last().click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  await page.getByRole('dialog').getByRole('combobox').filter({ hasText: 'MIMIC-IV Demo' }).click()
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: /MIMIC-IV Board example/ }).click()
  await expect(page.getByText('Patients (103)')).toBeVisible({ timeout: 120_000 })

  // A modest laptop: the CPU slowed down from here on.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })

  // The board's tabs open once a patient is picked: a small one first.
  await page.getByRole('button', { name: /^10000032 / }).click()
  // A tab is a sortable item, aria-disabled outside the edit mode: still a tab to click.
  await page.getByRole('button', { name: 'Data overview', exact: true }).click({ force: true })
  const overview = page.locator('canvas[aria-busy]').first()
  for (const patient of PATIENTS) {
    await page.getByPlaceholder(/^Search an ID/).fill(patient)
    const row = page.getByRole('button', { name: new RegExp(`^${patient} `) })
    await expect(row).toBeVisible({ timeout: 120_000 })
    const t0 = Date.now()
    await row.click()
    await expect(overview).toHaveAttribute('aria-busy', 'false', { timeout: 600_000 })
    await expect(overview).toHaveAttribute('data-pending', '0', { timeout: 600_000 })
    console.log(`patient ${patient}: data overview drawn in ${((Date.now() - t0) / 1000).toFixed(1)} s (CPU ÷${THROTTLE})`)
    await page.screenshot({ path: `test-results/overview-dense-${patient}.png` })
  }
})
