import { DatabaseSync } from 'node:sqlite'
import type { Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// A database's concept statistics run for minutes on the server, as jobs. A
// reload loses the run the page drove, not its jobs: the page must follow them
// again — still running, paused from it, resumed — and never start a second
// run beside them. The OMOP CDM 5.4 schema comes with the demo workspace, so
// this needs an instance holding it (E2E_DEMO=1; npm run test:versioning -- long-runs).
test.skip(!process.env.E2E_DEMO, 'needs the demo workspace (E2E_DEMO=1)')
test.describe.configure({ mode: 'serial' })
test.beforeEach(async ({ page }) => signIn(page))

const CONCEPTS = 60_000
const MEASUREMENTS = 6_000_000

/** An OMOP SQLite file whose statistics take a while: 60,000 concepts with
 *  records, in batches of 100 that each scan its 6 million measurements —
 *  about two minutes. Every
 *  table of the schema's DDL exists — empty but those three — as on a real
 *  warehouse; SQLite takes the DDL once its constraints are left out. */
function writeDatabase(file: string, ddl: string) {
  const db = new DatabaseSync(file)
  for (const statement of ddl.replace(/--[^\n]*/g, '').split(';')) {
    if (/^\s*CREATE TABLE/i.test(statement)) db.exec(statement.replace(/\bNOT NULL\b/g, ''))
  }
  db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CONCEPTS})
    INSERT INTO concept (concept_id, concept_name, domain_id, vocabulary_id, concept_class_id, standard_concept, concept_code)
      SELECT i, 'Lab ' || i, 'Measurement', 'LOCAL', 'Lab Test', 'S', 'L' || i FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
    INSERT INTO person (person_id, gender_concept_id, year_of_birth) SELECT i, 8507, 1940 + i % 60 FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MEASUREMENTS})
    INSERT INTO measurement (measurement_id, person_id, measurement_concept_id, measurement_date, value_as_number, measurement_source_concept_id)
      SELECT i, 1 + (i * 31) % 5000, 1 + i % ${CONCEPTS}, date('2020-01-01', '+' || (i % 1000) || ' days'), (i % 997) / 10.0, 0 FROM n;
  `)
  db.close()
}

let databaseName = ''

async function apiCall<T>(page: Page, url: string, data?: unknown): Promise<T> {
  const base = process.env.E2E_API_URL ?? new URL(page.url()).origin
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  const headers = { Authorization: `Bearer ${token}` }
  const res = data === undefined
    ? await page.request.get(`${base}/api/v1${url}`, { headers })
    : await page.request.post(`${base}/api/v1${url}`, { headers, data })
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true)
  return res.json()
}
const apiGet = <T>(page: Page, url: string) => apiCall<T>(page, url)

async function demoWorkspace(page: Page): Promise<string> {
  const workspaces = await apiGet<{ id: string; name: { en?: string } }[]>(page, '/workspaces')
  return workspaces.find((w) => w.name.en === 'Demo workspace')!.id
}

/** The demo workspace's databases page. */
async function databases(page: Page) {
  await page.goto(`./workspaces/${await demoWorkspace(page)}/warehouse/databases`)
}

async function openConcepts(page: Page) {
  await databases(page)
  await page.getByRole('button', { name: new RegExp(`^${databaseName} Connected`) }).click()
  await page.getByRole('tab', { name: 'Concepts' }).click()
}

interface Run { id: string; status: string; state: { stage?: string; done?: number } }
interface JobRow { id: string; kind: string; status: string; stopping?: boolean }

/** The database's concepts run on the server, as the page reads it. */
async function latestRun(page: Page, sourceId: string, kind: 'stats' | 'extraction', scopeId?: string): Promise<Run | null> {
  const params = new URLSearchParams({ kind, scopeId: scopeId ?? sourceId })
  return apiGet<Run | null>(page, `/server-runs/latest?${params}`)
}

/** The run jobs of the workspace still going on: one per run, whatever the reloads. */
async function liveRunJobs(page: Page, workspaceId: string): Promise<JobRow[]> {
  const jobs = await apiGet<JobRow[]>(page, `/workspaces/${workspaceId}/jobs`)
  return jobs.filter((j) => j.kind === 'server_run' && (j.status === 'queued' || j.status === 'running'))
}

async function databaseId(page: Page, workspaceId: string): Promise<string> {
  const sources = await apiGet<{ id: string; name: string | { en?: string } }[]>(page, `/data-sources?workspaceId=${workspaceId}`)
  return sources.find((d) => (typeof d.name === 'string' ? d.name : d.name.en) === databaseName)!.id
}

test('the concept statistics keep running through a reload, and pause and resume from the page', async ({ page }, testInfo) => {
  test.setTimeout(420_000)
  databaseName = `E2E long runs ${Date.now()}`
  const file = testInfo.outputPath('long-runs.sqlite')
  const presets = await apiGet<{ presetId: string; mapping: { ddl: string } }[]>(page, '/schema-presets')
  writeDatabase(file, presets.find((p) => p.presetId === 'omop-cdm-5-4')!.mapping.ddl)

  await databases(page)
  await page.getByRole('button', { name: 'Add database' }).click()
  await page.getByRole('menuitem', { name: 'Add connection' }).click()
  await page.getByRole('button', { name: /^Database DuckDB/ }).click()
  await page.getByPlaceholder('e.g. MIMIC-IV OMOP').fill(databaseName)
  await page.getByRole('tab', { name: 'Connection' }).click()
  await page.getByRole('combobox').filter({ hasText: 'No schema (raw SQL access)' }).click()
  await page.getByRole('option', { name: 'OMOP CDM 5.4' }).click()
  await page.getByRole('combobox').filter({ hasText: 'PostgreSQL' }).click()
  await page.getByRole('option', { name: 'SQLite' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /^Click to browse or drag and drop/ }).click(),
  ])
  await chooser.setFiles(file)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: new RegExp(`^${databaseName} Connected`) })).toBeVisible({ timeout: 120_000 })

  const workspaceId = await demoWorkspace(page)
  const sourceId = await databaseId(page, workspaceId)
  await openConcepts(page)
  await page.getByRole('button', { name: 'Load concepts' }).click()
  const pause = page.getByRole('button', { name: 'Pause' })
  await expect(pause).toBeVisible()

  // Reloaded at once — while the concepts are still being counted — the page
  // finds the run where the server has it.
  await expect.poll(async () => (await latestRun(page, sourceId, 'stats'))?.status, { timeout: 60_000 }).toMatch(/queued|running/)
  await page.reload()
  await page.getByRole('tab', { name: 'Concepts' }).click()
  await expect(pause).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Load concepts' })).toHaveCount(0)

  // Into the statistics, reloaded again: still the one run, the one job.
  await expect(page.getByText(/Statistics \d+ %/)).toBeVisible({ timeout: 300_000 })
  await page.reload()
  await page.getByRole('tab', { name: 'Concepts' }).click()
  await expect(pause).toBeVisible({ timeout: 60_000 })
  expect(await liveRunJobs(page, workspaceId)).toHaveLength(1)

  // Paused from the page: the click shows at once, while the query in flight
  // stops; then the run stops, its job with it — within its deadline.
  await pause.click()
  await expect(pause).toHaveCount(0, { timeout: 2_000 })
  const resume = page.getByRole('button', { name: 'Resume' })
  await expect(resume).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await latestRun(page, sourceId, 'stats'))?.status, { timeout: 60_000 }).toBe('paused')
  await expect.poll(async () => (await liveRunJobs(page, workspaceId)).length, { timeout: 60_000 }).toBe(0)
  const pausedAt = (await latestRun(page, sourceId, 'stats'))!.state.done ?? 0

  // A reload while paused offers to resume, and starts nothing.
  await page.reload()
  await page.getByRole('tab', { name: 'Concepts' }).click()
  await expect(resume).toBeVisible()
  await expect(pause).toHaveCount(0)
  expect(await liveRunJobs(page, workspaceId)).toHaveLength(0)

  // Resumed where it stopped, not from the start; reloaded, still followed.
  await resume.click()
  await expect(pause).toBeVisible()
  const resumed = await latestRun(page, sourceId, 'stats')
  expect(resumed!.state.done ?? 0).toBeGreaterThanOrEqual(pausedAt)
  await page.reload()
  await page.getByRole('tab', { name: 'Concepts' }).click()
  await expect(pause).toBeVisible({ timeout: 60_000 })
  expect(await liveRunJobs(page, workspaceId)).toHaveLength(1)
  await pause.click()
  await expect(resume).toBeVisible({ timeout: 60_000 })
})

test('a mapping project’s extraction keeps running through a reload', async ({ page }) => {
  test.setTimeout(300_000)
  test.skip(!databaseName, 'needs the database of the journey above')
  const workspaceId = await demoWorkspace(page)
  const sourceId = await databaseId(page, workspaceId)
  const projectName = `E2E extraction ${Date.now()}`
  const project = await apiCall<{ id: string }>(page, '/mapping-projects', {
    id: `e2e-extraction-${Date.now()}`, workspaceId, name: { en: projectName }, sourceType: 'database', dataSourceId: sourceId,
  })

  await page.goto(`./workspaces/${workspaceId}/warehouse/concept-mapping/${project.id}?tab=source-concepts`)
  await page.getByRole('button', { name: 'Start extraction' }).click()
  const pause = page.getByRole('button', { name: 'Pause' })
  await expect(pause).toBeVisible()
  await expect.poll(async () => (await latestRun(page, sourceId, 'extraction', project.id))?.status, { timeout: 60_000 }).toMatch(/queued|running/)

  // Reloaded: followed again, no second run beside it.
  await page.reload()
  await expect(pause).toBeVisible({ timeout: 60_000 })
  expect(await liveRunJobs(page, workspaceId)).toHaveLength(1)

  await pause.click()
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await liveRunJobs(page, workspaceId)).length, { timeout: 60_000 }).toBe(0)
})
