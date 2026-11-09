import type { Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// A data catalog computes on the server: a reload in the middle finds the same
// run going on, Pause stops it between two queries and Resume carries on from
// the results it stored, to a computed catalog. Its size estimate and its
// disclosure audit are runs too, which a reload finds. Needs the demo workspace
// (E2E_DEMO=1; npm run test:versioning -- catalog-runs).
test.skip(!process.env.E2E_DEMO, 'needs the demo workspace (E2E_DEMO=1)')
test.beforeEach(async ({ page }) => signIn(page))

interface Run { id: string; status: string; error: string | null; state: { offset?: number; total?: number | null } }

async function api<T>(page: Page, method: 'GET' | 'POST' | 'DELETE', url: string, data?: unknown): Promise<T> {
  const base = process.env.E2E_API_URL ?? new URL(page.url()).origin
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  const headers = { Authorization: `Bearer ${token}` }
  const res = method === 'GET'
    ? await page.request.get(`${base}/api/v1${url}`, { headers })
    : method === 'DELETE'
      ? await page.request.delete(`${base}/api/v1${url}`, { headers })
      : await page.request.post(`${base}/api/v1${url}`, { headers, data })
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true)
  return res.status() === 204 ? (undefined as T) : res.json()
}

async function demoWorkspace(page: Page): Promise<string> {
  const workspaces = await api<{ id: string; name: { en?: string } }[]>(page, 'GET', '/workspaces')
  return workspaces.find((w) => w.name.en === 'Demo workspace')!.id
}

async function databaseId(page: Page, workspaceId: string, name: string): Promise<string> {
  const sources = await api<{ id: string; name: string | { en?: string } }[]>(page, 'GET', `/data-sources?workspaceId=${workspaceId}`)
  return sources.find((d) => (typeof d.name === 'string' ? d.name : d.name.en) === name)!.id
}

const VARIABLES = ['concept', 'period', 'service', 'age', 'sex'] as const
/** Every pair and triple: enough queries to reload and pause between two of them. */
const CROSSINGS = VARIABLES.flatMap((a, i) => VARIABLES.slice(i + 1).flatMap((b, j) => [
  [a, b], ...VARIABLES.slice(i + j + 2).map((c) => [a, b, c]),
]))

const latest = (page: Page, catalog: string, kind = 'catalog') => api<Run | null>(page, 'GET', `/server-runs/latest?kind=${kind}&scopeId=${catalog}`)

async function createCatalog(page: Page, ws: string, source: string, crossings: readonly (readonly string[])[]): Promise<string> {
  const catalog = `e2e-catalog-${Date.now()}`
  await api(page, 'POST', '/data-catalogs', {
    id: catalog, workspaceId: ws, name: { en: `E2E catalog ${catalog}` }, dataSourceId: source,
    variables: {
      concept: { enabled: true, level: 'concept', scope: 'all', topN: 100 },
      period: { enabled: true, granularity: 'month' },
      service: { enabled: true, level: 'visit', grouping: 'all', topN: 10, groups: {}, unassigned: 'other' },
      age: { enabled: true, brackets: [20, 40, 60, 80] },
      sex: { enabled: true },
    },
    crossings,
    counts: { visits: true, unitStays: true },
    anonymization: { threshold: 10, mode: 'replace' },
  })
  return catalog
}

test('a catalog computes through a reload, and pauses and resumes from the page', async ({ page }) => {
  test.setTimeout(480_000)
  await page.goto('./')
  const ws = await demoWorkspace(page)
  const source = await databaseId(page, ws, 'MIMIC-IV Demo OMOP')
  const catalog = await createCatalog(page, ws, source, CROSSINGS)

  await page.goto(`./workspaces/${ws}/warehouse/catalog/${catalog}?tab=config`)
  await page.getByRole('button', { name: 'Compute catalog' }).click()
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  await expect(pause).toBeVisible({ timeout: 30_000 })

  // Into the units, reloaded: the same run, still going on, the page shows it.
  await expect.poll(async () => {
    const run = await latest(page, catalog)
    return run?.status === 'running' && (run.state.offset ?? 0) > 0
  }, { timeout: 120_000 }).toBe(true)
  const runId = (await latest(page, catalog))!.id
  await page.reload()
  await expect(pause).toBeVisible({ timeout: 30_000 })
  expect(await latest(page, catalog)).toMatchObject({ id: runId, status: 'running' })

  // Paused from the page: the run waits, its results stored up to where it stopped.
  await pause.click()
  await expect.poll(async () => (await latest(page, catalog))?.status, { timeout: 60_000 }).toBe('paused')
  const paused = await latest(page, catalog)
  expect(paused!.state.offset).toBeGreaterThan(0)
  const stored = await api<{ computedSteps: number | null; status: string }>(page, 'GET', `/data-catalogs/${catalog}`)
  expect(stored.computedSteps).toBe(paused!.state.offset)
  const resume = page.getByRole('button', { name: 'Resume', exact: true })
  await expect(resume).toBeVisible({ timeout: 30_000 })

  // Resumed: the same run carries on to the end, and the catalog reads computed.
  await resume.click()
  await expect.poll(async () => (await latest(page, catalog))?.status, { timeout: 360_000 }).toMatch(/^(done|failed)$/)
  const done = await latest(page, catalog)
  expect(done!.error).toBeNull()
  expect(done).toMatchObject({ id: runId, status: 'done' })
  expect(done!.state.offset).toBe(done!.state.total)
  await expect(page.getByRole('button', { name: 'Recompute' })).toBeVisible({ timeout: 30_000 })
  const computed = await api<{ computedSteps: number | null; status: string }>(page, 'GET', `/data-catalogs/${catalog}`)
  expect(computed).toMatchObject({ computedSteps: null, status: 'success' })

  await api(page, 'DELETE', `/data-catalogs/${catalog}`)
})

test('a size estimate goes on through a reload, each estimate stored as it lands', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('./')
  const ws = await demoWorkspace(page)
  const catalog = await createCatalog(page, ws, await databaseId(page, ws, 'MIMIC-IV Demo OMOP'), CROSSINGS)

  await page.goto(`./workspaces/${ws}/warehouse/catalog/${catalog}?tab=config`)
  await page.getByRole('button', { name: 'Estimate yields' }).click()
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await latest(page, catalog, 'catalog_estimate'))?.status, { timeout: 60_000, intervals: [200] }).toBe('running')
  const runId = (await latest(page, catalog, 'catalog_estimate'))!.id

  // Reloaded: the same run, followed again — Stop shows while it goes on.
  await page.reload()
  const again = await latest(page, catalog, 'catalog_estimate')
  expect(again!.id).toBe(runId)
  if (again!.status === 'running') await expect(stop).toBeVisible({ timeout: 30_000 })

  await expect.poll(async () => (await latest(page, catalog, 'catalog_estimate'))?.status, { timeout: 240_000 }).toMatch(/^(done|failed)$/)
  const done = await latest(page, catalog, 'catalog_estimate')
  expect(done!.error).toBeNull()
  expect(done).toMatchObject({ id: runId, status: 'done' })
  const estimates = await api<Record<string, unknown>>(page, 'GET', `/data-catalogs/${catalog}/estimates`)
  // Each variable alone, and each crossing.
  expect(Object.keys(estimates)).toHaveLength(VARIABLES.length + CROSSINGS.length)
  await expect(page.getByRole('button', { name: 'Estimate yields' })).toBeVisible({ timeout: 30_000 })

  await api(page, 'DELETE', `/data-catalogs/${catalog}`)
})

test('a disclosure audit is taken up after a reload, not run again', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('./')
  const ws = await demoWorkspace(page)
  const catalog = await createCatalog(page, ws, await databaseId(page, ws, 'MIMIC-IV Demo OMOP'), [['period', 'sex'], ['concept', 'sex']])

  await page.goto(`./workspaces/${ws}/warehouse/catalog/${catalog}?tab=config`)
  await page.getByRole('button', { name: 'Compute catalog' }).click()
  await expect.poll(async () => (await latest(page, catalog))?.status, { timeout: 240_000 }).toBe('done')

  await page.goto(`./workspaces/${ws}/warehouse/catalog/${catalog}?tab=anonymization`)
  await expect(page.getByText('Not run yet on these results.')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Run the audit' }).click()
  await expect.poll(async () => (await latest(page, catalog, 'catalog_audit'))?.id, { timeout: 30_000, intervals: [100] }).toBeTruthy()
  const runId = (await latest(page, catalog, 'catalog_audit'))!.id

  // Reloaded, the run going on or ended meanwhile: its audit shows, no second run.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Not run yet on these results.')).toHaveCount(0)
  expect(await latest(page, catalog, 'catalog_audit')).toMatchObject({ id: runId, status: 'done' })

  await api(page, 'DELETE', `/data-catalogs/${catalog}`)
})

