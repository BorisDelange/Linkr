import { DatabaseSync } from 'node:sqlite'
import { test, expect, signIn } from '../fixtures'

// One workspace for the whole file, built step by step: each journey starts where
// the previous one left the instance, so they run in order and stop at the first
// failure. Names carry the run's time so a rerun on a kept instance never collides.
test.describe.configure({ mode: 'serial' })

let stamp = 0
let workspaceUrl = ''
const workspaceName = () => `E2E workspace ${stamp}`
const databaseName = () => `E2E database ${stamp}`

test.beforeEach(async ({ page }) => signIn(page))

test('a new workspace gets a database uploaded to the server and queried there', async ({ page }, testInfo) => {
  stamp = Date.now()
  // Three patients in a SQLite file: the SPE's datamarts start empty, and SQLite
  // is read through an extension the image bundles, so it works offline.
  const file = testInfo.outputPath('e2e.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE patients (patient_id INTEGER PRIMARY KEY, sex TEXT, age INTEGER);
    INSERT INTO patients VALUES (1, 'F', 54), (2, 'M', 61), (3, 'F', 72);`)
  db.close()

  await page.goto('./workspaces')
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByLabel('Workspace name').fill(workspaceName())
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: workspaceName() })).toBeVisible()
  workspaceUrl = page.url().replace(/\/home$/, '')

  await page.goto(`${workspaceUrl}/warehouse/databases`)
  await page.getByRole('button', { name: 'Add database' }).click()
  await page.getByRole('menuitem', { name: 'Add connection' }).click()
  await page.getByRole('button', { name: /^Database DuckDB/ }).click()
  await page.getByPlaceholder('e.g. MIMIC-IV OMOP').fill(databaseName())
  await page.getByRole('tab', { name: 'Connection' }).click()
  await page.getByRole('combobox').filter({ hasText: 'PostgreSQL' }).click()
  await page.getByRole('option', { name: 'SQLite' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /^Click to browse or drag and drop/ }).click(),
  ])
  await chooser.setFiles(file)
  await page.getByRole('button', { name: 'Create' }).click()

  const card = page.getByRole('button', { name: new RegExp(`^${databaseName()} Connected · Sqlite`) })
  await expect(card).toBeVisible()
  await card.click()
  await page.getByRole('tab', { name: 'SQL' }).click()
  // Ctrl, not Cmd: the Desktop Chrome device reports Windows to the editor.
  await page.getByRole('textbox', { name: 'Editor content' }).focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText('SELECT sex, count(*) AS n, avg(age) AS mean_age FROM patients GROUP BY sex ORDER BY sex')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByRole('row', { name: '1 F 2 63' })).toBeVisible()
  await expect(page.getByRole('row', { name: '2 M 1 61' })).toBeVisible()
})

test('a new project links the workspace database', async ({ page }) => {
  await page.goto(`${workspaceUrl}/projects`)
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(`E2E project ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/projects\/[^/]+\/summary$/)

  await page.goto(page.url().replace(/\/summary$/, '/warehouse/databases'))
  await expect(page.getByText('No databases', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Link database' }).click()
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${databaseName()}`) }).click()
  await expect(page.getByRole('button', { name: new RegExp(`^${databaseName()} Connected · Sqlite`) })).toBeVisible()
})
