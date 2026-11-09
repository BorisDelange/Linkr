import type { Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// The concept runs on real warehouse shapes, to the end: the demo's MIMIC-IV in
// its native schema (several dictionaries, codes hashed into ids) and in OMOP.
// A run compiled by the page and run by the server must finish with every
// concept profiled, none failed. Needs the demo workspace (E2E_DEMO=1;
// npm run test:versioning -- demo-runs).
test.skip(!process.env.E2E_DEMO, 'needs the demo workspace (E2E_DEMO=1)')
test.describe.configure({ mode: 'serial' })
test.beforeEach(async ({ page }) => signIn(page))

interface Run {
  status: string
  error: string | null
  state: { done?: number; total?: number; failedCount?: number }
}

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

async function databaseId(page: Page, workspaceId: string, name: string): Promise<string> {
  const sources = await apiGet<{ id: string; name: string | { en?: string } }[]>(page, `/data-sources?workspaceId=${workspaceId}`)
  return sources.find((d) => (typeof d.name === 'string' ? d.name : d.name.en) === name)!.id
}

/** The run once it ended, as the server has it. */
async function ended(page: Page, sourceId: string, kind: 'stats' | 'extraction', scopeId?: string): Promise<Run> {
  const params = new URLSearchParams({ kind, scopeId: scopeId ?? sourceId })
  let run: Run | null = null
  await expect.poll(async () => {
    run = await apiGet<Run | null>(page, `/server-runs/latest?${params}`)
    return run?.status
  }, { timeout: 540_000, intervals: [2_000] }).toMatch(/^(done|failed|interrupted|cancelled)$/)
  return run!
}

function expectAllProfiled(run: Run) {
  expect(run.error, run.error ?? '').toBeNull()
  expect(run.status).toBe('done')
  expect(run.state.total).toBeGreaterThan(0)
  expect(run.state.done).toBe(run.state.total)
  expect(run.state.failedCount ?? 0).toBe(0)
}

for (const name of ['MIMIC-IV Demo', 'MIMIC-IV Demo OMOP']) {
  test(`the concepts of ${name} are counted and profiled to the end`, async ({ page }) => {
    test.setTimeout(600_000)
    const workspaceId = await demoWorkspace(page)
    const sourceId = await databaseId(page, workspaceId, name)
    await page.goto(`./workspaces/${workspaceId}/warehouse/databases`)
    await page.getByRole('button', { name: new RegExp(`^${name} Connected`) }).click()
    await page.getByRole('tab', { name: 'Concepts' }).click()
    await page.getByRole('button', { name: 'Load concepts' }).click()
    expectAllProfiled(await ended(page, sourceId, 'stats'))
    await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0, { timeout: 30_000 })
  })
}

test('a mapping project on the native MIMIC-IV extracts its source concepts to the end', async ({ page }) => {
  test.setTimeout(600_000)
  const workspaceId = await demoWorkspace(page)
  const sourceId = await databaseId(page, workspaceId, 'MIMIC-IV Demo')
  const project = await apiCall<{ id: string }>(page, '/mapping-projects', {
    id: `e2e-demo-extraction-${Date.now()}`, workspaceId, name: { en: 'E2E demo extraction' }, sourceType: 'database', dataSourceId: sourceId,
  })
  await page.goto(`./workspaces/${workspaceId}/warehouse/concept-mapping/${project.id}?tab=source-concepts`)
  await page.getByRole('button', { name: 'Start extraction' }).click()
  expectAllProfiled(await ended(page, sourceId, 'extraction', project.id))
})
