import type { Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// An ETL pipeline on a managed target runs on the server: a reload in the middle
// of a script finds the same run going on, Pause stops it there and Resume runs
// that script again, and the run ends with one history entry. Its Quality
// check's concept comparison is a run too, which a reload joins. Needs the demo
// workspace (E2E_DEMO=1; npm run test:versioning -- etl-runs).
test.skip(!process.env.E2E_DEMO, 'needs the demo workspace (E2E_DEMO=1)')
test.beforeEach(async ({ page }) => signIn(page))

// About ten seconds of DuckDB work: long enough to reload and pause inside it.
const SLOW = 'CREATE OR REPLACE TABLE target.slow AS SELECT sum(a.i * b.i) AS s FROM range(80000) a(i), range(80000) b(i);'

interface Run { id: string; status: string; state: { next?: number; scripts?: { fileId: string; status: string }[] } }

async function api<T>(page: Page, method: 'GET' | 'POST', url: string, data?: unknown): Promise<T> {
  const base = process.env.E2E_API_URL ?? new URL(page.url()).origin
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  const headers = { Authorization: `Bearer ${token}` }
  const res = method === 'GET'
    ? await page.request.get(`${base}/api/v1${url}`, { headers })
    : await page.request.post(`${base}/api/v1${url}`, { headers, data })
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true)
  return res.json()
}

async function demoWorkspace(page: Page): Promise<string> {
  const workspaces = await api<{ id: string; name: { en?: string } }[]>(page, 'GET', '/workspaces')
  return workspaces.find((w) => w.name.en === 'Demo workspace')!.id
}

const latest = (page: Page, target: string) => api<Run | null>(page, 'GET', `/server-runs/latest?kind=etl&scopeId=${target}`)

test('a pipeline keeps running through a reload, and pauses and resumes from the page', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('./')
  const ws = await demoWorkspace(page)
  const stamp = Date.now()
  const target = (await api<{ id: string }>(page, 'POST', '/data-sources', {
    workspaceId: ws, alias: `etl_e2e_${stamp}`, name: { en: `E2E ETL target ${stamp}` }, sourceType: 'database',
    connectionConfig: { engine: 'duckdb', managed: true },
  })).id
  await api(page, 'POST', `/data-sources/${target}/create-from-ddl`, { ddl: 'CREATE TABLE t (x BIGINT);' })
  const pipeline = (await api<{ id: string }>(page, 'POST', '/etl-pipelines', {
    id: `e2e-etl-${stamp}`, workspaceId: ws, name: { en: `E2E ETL ${stamp}` }, targetDataSourceId: target,
  })).id
  const scripts = [
    ['10_first.sql', 'INSERT INTO target.t VALUES (1), (2), (3);'],
    ['20_slow.sql', SLOW],
    ['30_last.sql', 'INSERT INTO target.t VALUES (4);'],
  ]
  for (const [order, [name, content]] of scripts.entries()) {
    await api(page, 'POST', '/etl-files', {
      id: `${pipeline}-f${order}`, pipelineId: pipeline, name, type: 'file', content, language: 'sql', order,
    })
  }

  const pipelineTab = page.getByRole('tab', { name: 'Pipeline' })
  await page.goto(`./workspaces/${ws}/warehouse/etl/${pipeline}`)
  await pipelineTab.click()
  await page.getByRole('button', { name: 'Run pipeline' }).click()
  const pause = page.getByRole('button', { name: 'Pause pipeline' })
  await expect(pause).toBeVisible({ timeout: 30_000 })

  // Into the slow script, reloaded: the same run, still going on, the page shows it.
  await expect.poll(async () => (await latest(page, target))?.state.next, { timeout: 60_000 }).toBe(1)
  const runId = (await latest(page, target))!.id
  await page.reload()
  await pipelineTab.click()
  await expect(pause).toBeVisible({ timeout: 30_000 })
  const again = await latest(page, target)
  expect(again).toMatchObject({ id: runId, status: 'running' })

  // Paused from the page: the slow script is cut, the run waits.
  await pause.click()
  await expect.poll(async () => (await latest(page, target))?.status, { timeout: 60_000 }).toBe('paused')
  const resume = page.getByRole('button', { name: 'Resume pipeline' })
  await expect(resume).toBeVisible()
  const paused = await latest(page, target)
  expect(paused!.state.scripts!.map((s) => s.status)).toEqual(['success', 'stopped'])

  // Resumed: the cut script runs again from its start, then the last one; one run.
  await resume.click()
  await expect.poll(async () => (await latest(page, target))?.status, { timeout: 120_000 }).toBe('done')
  const done = await latest(page, target)
  expect(done!.id).toBe(runId)
  expect(done!.state.scripts!.map((s) => s.status)).toEqual(['success', 'success', 'success'])
  const history = await api<{ id: string; status: string }[]>(page, 'GET', `/etl-pipelines/${pipeline}/runs`)
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ id: runId, status: 'success' })
  await expect(page.getByRole('button', { name: 'Run pipeline' })).toBeVisible({ timeout: 30_000 })
})

// A target whose measurements take seconds to read: a view over slow DuckDB work.
const QUALITY_DDL = `
CREATE TABLE concept AS SELECT * FROM (VALUES
  (2000000001, 'LOCAL', 'HR', 'Heart rate'),
  (3027018, 'LOINC', '8867-4', 'Heart rate')) t(concept_id, vocabulary_id, concept_code, concept_name);
CREATE TABLE concept_relationship AS SELECT * FROM (VALUES (2000000001, 3027018, 'Maps to')) t(concept_id_1, concept_id_2, relationship_id);
CREATE VIEW measurement AS
  SELECT r.i AS person_id, 3027018 AS measurement_concept_id, 2000000001 AS measurement_source_concept_id
  FROM range(10) r(i)
  CROSS JOIN (SELECT sum(a.i * b.i) AS s FROM range(60000) a(i), range(60000) b(i)) slow
  WHERE slow.s > 0;`

test('the concept comparison keeps running through a reload, and its table shows', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('./')
  const ws = await demoWorkspace(page)
  const stamp = Date.now()
  const target = (await api<{ id: string }>(page, 'POST', '/data-sources', {
    workspaceId: ws, alias: `etl_q_e2e_${stamp}`, name: { en: `E2E Quality target ${stamp}` }, sourceType: 'database',
    connectionConfig: { engine: 'duckdb', managed: true },
  })).id
  await api(page, 'POST', `/data-sources/${target}/create-from-ddl`, { ddl: QUALITY_DDL })
  const pipeline = (await api<{ id: string }>(page, 'POST', '/etl-pipelines', {
    id: `e2e-etl-q-${stamp}`, workspaceId: ws, name: { en: `E2E Quality ${stamp}` }, targetDataSourceId: target,
  })).id
  await api(page, 'POST', '/etl-files', {
    id: `${pipeline}-f0`, pipelineId: pipeline, name: '10_noop.sql', type: 'file', content: 'SELECT 1;', language: 'sql', order: 0,
  })
  const quality = () => api<Run | null>(page, 'GET', `/server-runs/latest?kind=etl_quality&scopeId=${pipeline}`)

  // One run of the pipeline, the comparison's reference.
  await page.goto(`./workspaces/${ws}/warehouse/etl/${pipeline}`)
  await page.getByRole('tab', { name: 'Pipeline' }).click()
  await page.getByRole('button', { name: 'Run pipeline' }).click()
  await expect.poll(async () => (await latest(page, target))?.status, { timeout: 60_000 }).toBe('done')

  const openConcepts = async () => {
    await page.getByRole('tab', { name: 'Quality check' }).click()
    await page.getByRole('button', { name: 'Concepts', exact: true }).click()
  }
  await openConcepts()
  await expect.poll(async () => (await quality())?.status, { timeout: 60_000 }).toBe('running')
  const runId = (await quality())!.id

  // Reloaded mid-comparison: the same run, followed again, nothing new started.
  await page.reload()
  await openConcepts()
  expect(await quality()).toMatchObject({ id: runId, status: 'running' })
  await expect.poll(async () => (await quality())?.status, { timeout: 180_000 }).toBe('done')
  expect((await quality())!.id).toBe(runId)
  await expect(page.getByText('HR', { exact: true })).toBeVisible({ timeout: 30_000 })
})

