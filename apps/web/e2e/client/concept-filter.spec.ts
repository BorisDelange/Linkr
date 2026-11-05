import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, bootDemo, DEMO_WS } from '../fixtures'

// 6,000 concepts, each its own domain, 1,200 of them "Mycologie <n>": more values
// than a column dropdown loads (FILTER_OPTIONS_LIMIT), so its search runs on the
// source, on Enter. data/many-categories/generate.py writes the folder.
const FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/many-categories')

test('a column filter with more values than it loads searches them all on Enter', async ({ page }) => {
  // Without the directory picker, the folder zone falls back on an <input
  // webkitdirectory> the test can fill; the picker itself cannot be driven.
  await page.addInitScript(() => { delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker })
  await bootDemo(page)

  const name = `E2E categories ${Date.now()}`
  await page.goto(`${DEMO_WS}/warehouse/databases`)
  await page.getByRole('button', { name: 'Add database' }).click()
  await page.getByRole('menuitem', { name: 'Add connection' }).click()
  await page.getByRole('button', { name: /^Database DuckDB/ }).click()
  await page.getByPlaceholder('e.g. MIMIC-IV OMOP').fill(name)
  await page.getByRole('tab', { name: 'Connection' }).click()
  // The schema first: its known tables decide how the folder's files are grouped.
  await page.getByRole('combobox').filter({ hasText: 'No schema (raw SQL access)' }).click()
  await page.getByRole('option', { name: 'OMOP CDM 5.4' }).click()
  await page.getByRole('button', { name: 'Parquet folder' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByText('Select a folder containing Parquet files').click(),
  ])
  await chooser.setFiles(FOLDER)
  await page.getByRole('button', { name: 'Create' }).click()

  await page.getByRole('button', { name: new RegExp(`^${name} Connected`) }).click()
  await page.getByRole('tab', { name: 'Concepts' }).click()
  await expect(page.getByText('6000 concepts', { exact: true })).toBeVisible()

  // The column's filter, not its header (which sorts): the trigger of a popover.
  const filter = page.getByRole('button', { name: 'Domain Id', exact: true, expanded: false })
  await filter.click()
  const popover = page.getByRole('dialog')
  await expect(popover.getByText('First values only — type and press Enter to search them all')).toBeVisible()

  // Typing alone searches nothing: the first page stays listed.
  const search = popover.getByPlaceholder('Search...')
  await search.fill('myco')
  await expect(popover.getByRole('button', { name: 'Bactériologie 0', exact: true })).toBeVisible()

  // Enter searches every value on the source and says how many match.
  await search.press('Enter')
  await expect(popover.getByText('Showing 200 of 1200 — refine your search')).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Mycologie 0', exact: true })).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Bactériologie 0', exact: true })).toHaveCount(0)

  // A second Enter selects the 1,200 matches as the search itself.
  await search.press('Enter')
  await expect(popover).toBeHidden()
  await expect(filter).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Matches “myco”' })).toBeVisible()
  await expect(page.getByText('1200 concepts', { exact: true })).toBeVisible()
  await expect(page.getByRole('row', { name: /Mycologie \d+/ }).first()).toBeVisible()
  await expect(page.getByRole('row', { name: /Biochimie \d+/ })).toHaveCount(0)
})
