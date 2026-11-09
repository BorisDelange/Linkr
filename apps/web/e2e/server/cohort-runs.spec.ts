import type { Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// A cohort runs on the server: a reload in the middle of its run finds the same
// run going on — Stop shows — and the page shows its count once it ends,
// computed once. Needs the demo workspace (E2E_DEMO=1;
// npm run test:versioning -- cohort-runs).
test.skip(!process.env.E2E_DEMO, 'needs the demo workspace (E2E_DEMO=1)')
test.beforeEach(async ({ page }) => signIn(page))

// The demo's 100 patients, each query of the run held a few seconds of DuckDB work.
const SLOW_MEMBERS = `SELECT p.person_id AS patient_id
FROM person p
CROSS JOIN (SELECT sum(a.i * b.i) AS s FROM range(60000) a(i), range(60000) b(i)) slow
WHERE slow.s > 0`

interface Run { id: string; status: string; error: string | null; state: { rows?: Record<string, number> } }

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

test('a cohort keeps running through a reload, and the page shows its end', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('./')
  const workspaces = await api<{ id: string; name: { en?: string } }[]>(page, 'GET', '/workspaces')
  const ws = workspaces.find((w) => w.name.en === 'Demo workspace')!.id
  const sources = await api<{ id: string; name: string | { en?: string } }[]>(page, 'GET', `/data-sources?workspaceId=${ws}`)
  const db = sources.find((d) => (typeof d.name === 'string' ? d.name : d.name.en) === 'MIMIC-IV Demo OMOP')!.id
  const stamp = Date.now()
  const uid = (await api<{ uid: string }>(page, 'POST', '/projects', {
    name: { en: `E2E cohort runs ${stamp}` }, workspaceId: ws, linkedDataSourceIds: [db],
  })).uid
  const cohortId = `e2e-cohort-${stamp}`
  await api(page, 'POST', '/cohorts', {
    id: cohortId, projectUid: uid, name: { en: 'Slow cohort' }, level: 'patient', customSql: SLOW_MEMBERS,
    criteriaTree: { kind: 'group', id: 'root', operator: 'AND', children: [], exclude: false, enabled: true },
  })
  const latest = () => api<Run | null>(page, 'GET', `/server-runs/latest?kind=cohort_run&scopeId=${cohortId}`)

  await page.goto(`./workspaces/${ws}/projects/${uid}/warehouse/cohorts/${cohortId}`)
  await page.getByRole('button', { name: 'Run query' }).first().click()
  const stop = page.getByRole('button', { name: 'Stop' })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await latest())?.status, { timeout: 60_000 }).toBe('running')
  const runId = (await latest())!.id

  // Reloaded mid-run: the same run, followed again — Stop shows, nothing new starts.
  await page.reload()
  await expect(stop).toBeVisible({ timeout: 30_000 })
  expect(await latest()).toMatchObject({ id: runId, status: 'running' })

  await expect.poll(async () => (await latest())?.status, { timeout: 180_000 }).toBe('done')
  const done = await latest()
  expect(done!.id).toBe(runId)
  expect(done!.state.rows?.results).toBe(100)
  await expect(page.getByText('patients', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('100', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run query' }).first()).toBeVisible()
})
