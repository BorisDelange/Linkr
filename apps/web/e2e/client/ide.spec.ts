import type { Locator, Page } from '@playwright/test'
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

/** HTML5 drag with real mouse events: `dragTo` stalls on a Monaco drop target. */
async function dragTab(page: Page, tab: Locator, target: Locator, at: 'center' | 'start' = 'center') {
  await tab.scrollIntoViewIfNeeded()
  const from = (await tab.boundingBox())!
  const box = (await target.boundingBox())!
  const to = at === 'start' ? { ...box, width: 16 } : box
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 5, { steps: 3 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 })
  await page.mouse.up()
}

test('a script and its result move between the two panels', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/ide`)
  await page.getByRole('button', { name: /^03_example\.sql/ }).click()
  const left = page.getByRole('group', { name: 'Main panel tabs' })
  const right = page.getByRole('group', { name: 'Second panel tabs' })

  await left.getByRole('button', { name: /^03_example\.sql/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to the other panel' }).click()
  await expect(right.getByRole('button', { name: /^03_example\.sql/ })).toBeVisible()
  await expect(left.getByRole('button', { name: /^03_example\.sql/ })).toHaveCount(0)

  // The toolbar follows the panel the script now lives in.
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText('1 rows', { exact: true })).toBeVisible({ timeout: 60_000 })

  const result = right.getByRole('button', { name: /^Result — 03_example\.sql/ })
  await dragTab(page, result, left)
  await expect(left.getByRole('button', { name: /^Result — 03_example\.sql/ })).toBeVisible()
  await expect(page.getByText('1 rows', { exact: true })).toBeVisible()

  // A re-run reuses that tab: the table comes back where its tab now lives,
  // never in the other pane under no tab.
  await right.getByRole('button', { name: /^03_example\.sql/ }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(right.getByRole('button', { name: /^Console/ })).toHaveText(/2/)
  await expect(left.getByRole('button', { name: /^Result — 03_example\.sql/ })).toBeVisible()
  await expect(right.getByRole('button', { name: /^Result/ })).toHaveCount(0)
  await expect(page.getByText('1 rows', { exact: true }).filter({ visible: true })).toHaveCount(1)

  await dragTab(page, right.getByRole('button', { name: /^03_example\.sql/ }), left)
  await expect(left.getByRole('button', { name: /^03_example\.sql/ })).toBeVisible()
})

test('tabs reorder by drag within each panel', async ({ page }) => {
  await bootDemo(page)
  await page.goto(`${MORTALITY}/ide`)
  for (const name of [/^03_example\.sql/, /^04_example\.py/, /^05_example\.R/]) {
    await page.getByRole('button', { name }).first().click()
  }
  const left = page.getByRole('group', { name: 'Main panel tabs' })
  // First word of each tab: the file name, or "Result" / "Console" for outputs.
  const names = async (group: Locator) =>
    (await group.getByRole('button').allInnerTexts()).map((s) => s.trim().split(/\s/)[0]).filter(Boolean)
  await expect.poll(() => names(left)).toEqual(['03_example.sql', '04_example.py', '05_example.R'])

  const first = left.getByRole('button', { name: /^03_example\.sql/ })
  await dragTab(page, left.getByRole('button', { name: /^05_example\.R/ }), first, 'start')
  await expect.poll(() => names(left)).toEqual(['05_example.R', '03_example.sql', '04_example.py'])

  // The same inside the second panel, once two scripts live there.
  const right = page.getByRole('group', { name: 'Second panel tabs' })
  for (const name of [/^05_example\.R/, /^03_example\.sql/]) {
    await left.getByRole('button', { name }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to the other panel' }).click()
  }
  await expect.poll(() => names(right)).toEqual(['05_example.R', '03_example.sql'])
  await dragTab(page, right.getByRole('button', { name: /^03_example\.sql/ }),
    right.getByRole('button', { name: /^05_example\.R/ }), 'start')
  await expect.poll(() => names(right)).toEqual(['03_example.sql', '05_example.R'])

  // Tabs of any kind mix: an output goes between two scripts, and a script from
  // the other panel lands exactly where it is dropped.
  await right.getByRole('button', { name: /^03_example\.sql/ }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect.poll(() => names(right)).toEqual(['03_example.sql', '05_example.R', 'Console', 'Result'])
  await dragTab(page, right.getByRole('button', { name: /^Result/ }),
    right.getByRole('button', { name: /^05_example\.R/ }), 'start')
  await expect.poll(() => names(right)).toEqual(['03_example.sql', 'Result', '05_example.R', 'Console'])
  await dragTab(page, left.getByRole('button', { name: /^04_example\.py/ }),
    right.getByRole('button', { name: /^Result/ }), 'start')
  await expect.poll(() => names(right)).toEqual(['03_example.sql', '04_example.py', 'Result', '05_example.R', 'Console'])
})
