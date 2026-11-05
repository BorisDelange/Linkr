import { execFileSync } from 'node:child_process'
import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// The precondition of every pull (docs/planning/collaborative-versioning-plan.md
// §9.2), in server mode, on real content: push an entity, rebuild it from what
// was pushed with the app's own reinstall, and the repository must find nothing
// to commit. Any file it lists is a phantom change every pull would show.
//
// Needs an instance holding the demo workspace (default data installed at first
// run) and LINKR_GIT_ALLOW_LOCAL_REMOTES=true; run with E2E_DEMO=1 and
// E2E_GIT_LOCAL_REMOTES=1. It rewires the demo's git links to local bare
// repositories, so use a disposable instance.
test.describe.configure({ mode: 'serial' })

interface Target {
  scope: string
  type: string
  list: string
  key: 'uid' | 'id'
  /** Where the entity's git link is written: PATCH with the link, or a full PUT. */
  link: { method: 'patch' | 'put'; url: (id: string) => string }
}

const TARGETS: Target[] = [
  { scope: 'projects', type: 'project', list: '/projects', key: 'uid', link: { method: 'patch', url: (id) => `/projects/${id}` } },
  { scope: 'mapping-projects', type: 'mapping-project', list: '/mapping-projects', key: 'id', link: { method: 'patch', url: (id) => `/mapping-projects/${id}` } },
  { scope: 'etl-pipelines', type: 'etl-pipeline', list: '/etl-pipelines', key: 'id', link: { method: 'patch', url: (id) => `/etl-pipelines/${id}` } },
  { scope: 'schema-presets', type: 'schema-preset', list: '/schema-presets', key: 'id', link: { method: 'put', url: (id) => `/schema-presets/${id}` } },
]
// Databases are left out: their data files are not versioned unless marked, so a
// reinstall from a repo without them empties the database and its table list —
// what a pull never does (absent from both sides, the data is no change). Their
// round trip is covered by the pull-engine journeys.

async function api(page: Page, request: APIRequestContext) {
  const base = process.env.E2E_API_URL ?? new URL(page.url()).origin
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  const headers = { Authorization: `Bearer ${token}` }
  const ok = async (res: Promise<import('@playwright/test').APIResponse>) => {
    const r = await res
    expect(r.ok(), `${r.url()} → ${r.status()} ${(await r.text()).slice(0, 400)}`).toBe(true)
    return r
  }
  return {
    get: async (url: string) => (await ok(request.get(`${base}/api/v1${url}`, { headers }))).json(),
    patch: (url: string, data: unknown) => ok(request.patch(`${base}/api/v1${url}`, { headers, data })),
    put: (url: string, data: unknown) => ok(request.put(`${base}/api/v1${url}`, { headers, data })),
    git: (url: string, form: Record<string, string>) =>
      ok(request.post(`${base}/api/v1/git${url}`, { headers, multipart: form, timeout: 300_000 })),
  }
}

test('every entity of the demo workspace survives push → reinstall with nothing left to commit', async ({ page, request }, testInfo) => {
  test.skip(!process.env.E2E_DEMO || !process.env.E2E_GIT_LOCAL_REMOTES, 'needs the demo workspace and local git remotes')
  test.setTimeout(1_800_000)
  await signIn(page)
  const http = await api(page, request)
  const workspaces: { id: string; name: { en?: string } }[] = await http.get('/workspaces')
  const ws = workspaces.find((w) => w.name.en === 'Demo workspace')
  expect(ws, 'the demo workspace').toBeTruthy()

  const report: string[] = []
  for (const target of TARGETS) {
    const all: Record<string, unknown>[] = await http.get(`${target.list}?workspaceId=${ws!.id}`)
    for (const entity of all) {
      const id = String(entity[target.key])
      const label = `${target.scope}/${id}`
      const remote = testInfo.outputPath(`${target.scope}-${id}.git`)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
      const url = `file://${remote}`
      const link = { gitRemoteConfig: { url, branch: 'main' } }
      if (target.link.method === 'patch') await http.patch(target.link.url(id), link)
      else await http.put(target.link.url(id), { ...entity, ...link })
      await http.git(`/${target.scope}/${id}/commit-push`, { message: 'Round trip', branch: 'main' })

      const result = await page.evaluate(async (args) => {
        // A module of the app as the dev server serves it, out of the test's own typecheck.
        const url = '/src/lib/entity-reinstall.ts'
        const mod = (await import(url)) as {
          reinstallEntityFromGit: (a: unknown) => Promise<{ ok: boolean; reason?: string; context?: string; error?: string; issues?: unknown[] }>
        }
        return mod.reinstallEntityFromGit(args)
      }, { scope: target.scope, type: target.type, id, name: label, url, branch: 'main', workspaceId: ws!.id })
      const why = result.ok ? '' : JSON.stringify({ reason: result.reason, context: result.context, error: result.error, issues: result.issues })
      expect.soft(result, `${label}: reinstall ${why}`).toMatchObject({ ok: true })

      const status = await (await http.git(`/${target.scope}/${id}/status`, { branch: 'main' })).json()
      const files: { path: string; changeType: string }[] = status.files ?? []
      const left = files.map((f) => `${f.changeType} ${f.path}`)
      if (left.length) report.push(`${label}: ${left.join(', ')}`)
      expect.soft(left, `${label}: left to commit after a round trip`).toEqual([])
    }
  }
  await testInfo.attach('round-trip report', { body: report.join('\n') || 'clean', contentType: 'text/plain' })
  if (process.env.E2E_SHOTS) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${process.env.E2E_SHOTS}/roundtrip-report.txt`, report.join('\n') || 'clean')
  }
})
