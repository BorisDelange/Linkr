import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// A mapping project's own pull, in its versioning tab: a colleague changes two
// mappings and the README; here, one mapping is taken and the other kept through
// the mappings table, the README taken — and only what was kept is left to push.
//
// Needs the demo workspace (its MIMIC-IV Demo mapping project) and a server with
// LINKR_GIT_ALLOW_LOCAL_REMOTES=true (E2E_DEMO=1, E2E_GIT_LOCAL_REMOTES=1). It
// rewires the project's git link: use a disposable instance.
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

async function api(page: Page, request: APIRequestContext) {
  const base = process.env.E2E_API_URL ?? new URL(page.url()).origin
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  const headers = { Authorization: `Bearer ${token}` }
  const ok = async (res: Promise<import('@playwright/test').APIResponse>) => {
    const r = await res
    expect(r.ok(), `${r.url()} → ${r.status()} ${(await r.text()).slice(0, 500)}`).toBe(true)
    return r.json()
  }
  return {
    get: (url: string) => ok(request.get(`${base}/api/v1${url}`, { headers })),
    patch: (url: string, data: unknown) => ok(request.patch(`${base}/api/v1${url}`, { headers, data })),
    git: (url: string, form: Record<string, string>) =>
      ok(request.post(`${base}/api/v1/git${url}`, { headers, multipart: form, timeout: 300_000 })),
  }
}

interface Mapping { sourceVocabularyId: string; sourceConceptCode: string; targetConceptId: number; status: string }

test('a mapping project pulls a colleague’s mappings one by one, through its mappings table', async ({ page, request }, testInfo) => {
  test.skip(!process.env.E2E_DEMO || !process.env.E2E_GIT_LOCAL_REMOTES, 'needs the demo workspace and local git remotes')
  test.setTimeout(300_000)
  await signIn(page)
  const http = await api(page, request)
  const workspaces: { id: string; name: { en?: string } }[] = await http.get('/workspaces')
  const ws = workspaces.find((w) => w.name.en === 'Demo workspace')!
  const projects: { id: string; name: { en?: string } }[] = await http.get(`/mapping-projects?workspaceId=${ws.id}`)
  const project = projects.find((p) => p.name.en === 'MIMIC-IV Demo')
  expect(project, 'the demo mapping project').toBeTruthy()

  const remote = testInfo.outputPath('mapping.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  await http.patch(`/mapping-projects/${project!.id}`, { gitRemoteConfig: { url: `file://${remote}`, branch: 'main' } })
  expect((await http.git(`/mapping-projects/${project!.id}/commit-push`, { message: 'First push', branch: 'main' })).pushed).toBe(true)

  // The colleague flags two mappings (different source codes) and adds to the README.
  const clone = testInfo.outputPath('colleague')
  execFileSync('git', ['clone', '-q', `file://${remote}`, clone])
  git(clone, 'config', 'user.name', 'Colleague')
  git(clone, 'config', 'user.email', 'colleague@example.org')
  const mappingsPath = path.join(clone, 'mappings.json')
  const mappings = JSON.parse(readFileSync(mappingsPath, 'utf-8')) as Mapping[]
  const taken = mappings[0]
  const kept = mappings.find((m) => m.sourceConceptCode !== taken.sourceConceptCode)!
  for (const m of [taken, kept]) m.status = 'flagged'
  writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2))
  const readme = path.join(clone, 'README.md')
  writeFileSync(readme, `${readFileSync(readme, 'utf-8').replace(/\n*$/, '\n\n')}Reviewed by the colleague.\n`)
  git(clone, 'add', '-A')
  git(clone, 'commit', '-q', '-m', 'Colleague: flag two mappings')
  git(clone, 'push', '-q', 'origin', 'HEAD:main')

  await page.goto(`./workspaces/${ws.id}/warehouse/concept-mapping/${project!.id}?tab=versioning`)
  // Quick actions: the mappings card counts what came in.
  await expect(page.getByText('Mappings', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('2 updated').first()).toBeVisible()

  // Details: the mappings file opens its table; untick one of the two, confirm.
  await page.getByRole('tab', { name: 'Details' }).click()
  const row = (file: string) => page.getByRole('listitem').filter({ hasText: file })
  await row('mappings.json').getByRole('button', { name: 'Choose' }).click()
  const table = page.getByRole('dialog')
  await expect(table.getByText('2 of 2 selected')).toBeVisible()
  await table.getByRole('row').filter({ hasText: kept.sourceConceptCode }).getByRole('button').first().click()
  await expect(table.getByText('1 of 2 selected')).toBeVisible()
  await table.getByRole('button', { name: 'Confirm' }).click()
  await row('README.md').getByRole('button', { name: 'Take all' }).first().click()
  await page.getByRole('button', { name: 'Apply and finish' }).click()

  // Back to pushing: what was kept here is the only thing left to send.
  await expect(page.getByText('0 added · 1 modified · 0 deleted')).toBeVisible({ timeout: 60_000 })
  const status = await http.git(`/mapping-projects/${project!.id}/status`, { branch: 'main' })
  expect((status.files as { path: string }[]).map((f) => f.path)).toEqual(['mappings.json'])

  const after: Mapping[] = await http.get(`/mapping-projects/${project!.id}/mappings`)
  const find = (m: Mapping) => after.find((a) => a.sourceVocabularyId === m.sourceVocabularyId
    && a.sourceConceptCode === m.sourceConceptCode && a.targetConceptId === m.targetConceptId)
  expect(find(taken)?.status, 'the taken mapping').toBe('flagged')
  expect(find(kept)?.status, 'the kept mapping').toBe('approved')
})
