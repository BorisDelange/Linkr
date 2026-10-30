import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// Every kind of versioned entity, through every collaborative flow
// (docs/planning/collaborative-versioning-plan.md §9.5): push, a colleague's
// change pulled back, the same on another branch, and — with the local GitLab of
// docker/forge-sim — a change proposed as a merge request, merged on the forge,
// then pulled. The pull runs the panel's own code (lib/pull/run.ts) in the page.
//
// Needs the demo workspace and LINKR_GIT_ALLOW_LOCAL_REMOTES=true (E2E_DEMO=1,
// E2E_GIT_LOCAL_REMOTES=1); the merge-request journey also needs forge-sim up and
// seeded with LINKR_GIT_ALLOWED_HOSTS=localhost:8929 (E2E_FORGE=1). It rewires the
// demo's git links: use a disposable instance.
test.describe.configure({ mode: 'serial' })

const run = Date.now()
const FORGE = 'http://localhost:8929'
const FORGE_TOKENS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docker/forge-sim/.tokens')

interface Http {
  get: (url: string) => Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  send: (method: 'post' | 'patch' | 'put', url: string, data: unknown) => Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  git: (url: string, form: Record<string, string | string[]>) => Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function api(page: Page, request: APIRequestContext): Promise<Http> {
  const base = process.env.E2E_API_URL ?? new URL(page.url()).origin
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  const headers = { Authorization: `Bearer ${token}` }
  const ok = async (res: Promise<import('@playwright/test').APIResponse>) => {
    const r = await res
    expect(r.ok(), `${r.url()} → ${r.status()} ${(await r.text()).slice(0, 500)}`).toBe(true)
    return r.status() === 204 ? null : r.json()
  }
  return {
    get: (url) => ok(request.get(`${base}/api/v1${url}`, { headers })),
    send: (method, url, data) => ok(request[method](`${base}/api/v1${url}`, { headers, data })),
    git: async (url, form) => {
      // Repeated fields (`paths`) need a FormData: a plain object takes one value per key.
      const data = new FormData()
      for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) data.append(k, one)
      // A git operation past the gateway's patience answers 202 {deferredTaskId}
      // and goes on in the background: follow it, as the app does.
      let result = await ok(request.post(`${base}/api/v1/git${url}`, { headers, multipart: data, timeout: 300_000 }))
      for (let i = 0; result?.deferredTaskId && i < 300; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const poll = await request.get(`${base}/api/v1/deferred/${result.deferredTaskId}`, { headers })
        expect(poll.status() < 400, `deferred ${url} → ${poll.status()} ${(await poll.text()).slice(0, 300)}`).toBe(true)
        if (poll.status() !== 202) result = await poll.json()
      }
      return result
    },
  }
}

/** One entity under test, and how to rewrite its git link and its README. */
interface Target {
  label: string
  scope: string
  id: string
  workspaceId: string
  link: (remote: { url: string; branch: string }) => Promise<void>
  readme: (text: string) => Promise<void>
  /** The file the colleague edits in the repository. */
  colleagueFile: string
  /** How the colleague edits it: a paragraph appended, unless the file is data. */
  colleagueEdit?: (content: string, note: string) => string
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

/** A colleague edits `file` on `branch` (created from main when new): a paragraph
 *  appended, or `edit` applied to its content. */
function colleagueEdits(remote: string, dir: string, branch: string, file: string, paragraph: string, edit?: (content: string, note: string) => string) {
  if (!existsSync(dir)) {
    execFileSync('git', ['clone', '-q', remote, dir])
    git(dir, 'config', 'user.name', 'Colleague')
    git(dir, 'config', 'user.email', 'colleague@example.org')
  }
  git(dir, 'fetch', '-q', 'origin')
  const exists = git(dir, 'ls-remote', '--heads', 'origin', branch).trim() !== ''
  git(dir, 'checkout', '-q', '-B', branch, exists ? `origin/${branch}` : 'origin/main')
  const target = path.join(dir, file)
  mkdirSync(path.dirname(target), { recursive: true })
  if (edit) writeFileSync(target, edit(readFileSync(target, 'utf-8'), paragraph))
  else {
    const before = existsSync(target) ? readFileSync(target, 'utf-8').replace(/\n*$/, '\n\n') : ''
    writeFileSync(target, `${before}${paragraph}\n`)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', `Colleague: ${paragraph}`)
  git(dir, 'push', '-q', 'origin', `HEAD:${branch}`)
}

async function pullEverything(page: Page, t: Target, branch: string): Promise<string[]> {
  return page.evaluate(async ({ scope, id, branch, workspaceId }) => {
    // A module of the app as the dev server serves it, out of the test's own typecheck.
    const url = '/src/lib/pull/run.ts'
    const mod = (await import(url)) as { pullEverything: (...a: unknown[]) => Promise<string[]> }
    return mod.pullEverything(scope, id, branch, workspaceId)
  }, { scope: t.scope, id: t.id, branch, workspaceId: t.workspaceId })
}

async function leftToCommit(http: Http, t: Target, branch: string): Promise<string[]> {
  const status = await http.git(`/${t.scope}/${t.id}/status`, { branch })
  return (status.files as { path: string; changeType: string }[]).map((f) => `${f.changeType} ${f.path}`)
}

let batch = 0

async function targets(http: Http, workspaceId: string): Promise<Target[]> {
  // Each journey creates its own entities: ids carry the run and the batch.
  const tag = `${run}-${++batch}`
  // A PUT replaces the whole row: send it as it stands now, or an earlier read
  // puts back what changed since (the git link, typically).
  const T = (label: string, scope: string, id: string, linkUrl: string, method: 'patch' | 'put' = 'patch', current?: () => Promise<Record<string, unknown>>): Target => ({
    label, scope, id, workspaceId, colleagueFile: 'README.md',
    link: async (remote) => { await http.send(method, linkUrl, { ...(current ? await current() : {}), gitRemoteConfig: remote }) },
    readme: async (text) => { await http.send(method, linkUrl, { ...(current ? await current() : {}), readme: { en: text } }) },
  })
  const out: Target[] = []
  // E2E_ONLY=<label> replays one kind (the labels below).
  const only = process.env.E2E_ONLY

  // The workspace itself, holding one project of its own (inline in its repo).
  // With the identities the app mints on creation: an export names a project by them.
  await http.send('post', '/projects', {
    workspaceId, uid: `inline-${tag}`, entityId: `inline-${tag}`, lineageId: crypto.randomUUID(),
    name: { en: `Inline ${tag}` }, readme: { en: 'Inline project.\n' },
  })
  out.push({ ...T('workspace', 'workspaces', workspaceId, `/workspaces/${workspaceId}`), colleagueFile: `projects/inline-${tag}/README.md` })

  const projects = await http.get(`/projects?workspaceId=${workspaceId}`)
  const project = projects.find((p: { uid: string }) => p.uid === 'icu-activity-dashboard')
  out.push(T('project', 'projects', project.uid, `/projects/${project.uid}`))

  const sqlId = `sql-${tag}`
  await http.send('post', '/sql-script-collections', { id: sqlId, workspaceId, name: { en: `SQL ${tag}` } })
  await http.send('post', '/sql-script-files', { id: `sqlf-${tag}`, collectionId: sqlId, name: 'count.sql', content: 'SELECT 1;\n' })
  out.push(T('SQL collection', 'sql-script-collections', sqlId, `/sql-script-collections/${sqlId}`))

  const dqId = `dq-${tag}`
  await http.send('post', '/dq-rule-sets', { id: dqId, workspaceId, name: { en: `DQ ${tag}` }, status: 'draft' })
  out.push(T('DQ rule set', 'dq-rule-sets', dqId, `/dq-rule-sets/${dqId}`))

  const catId = `cat-${tag}`
  await http.send('post', '/data-catalogs', { id: catId, workspaceId, name: { en: `Catalog ${tag}` } })
  out.push(T('data catalog', 'data-catalogs', catId, `/data-catalogs/${catId}`))

  const [etl] = await http.get(`/etl-pipelines?workspaceId=${workspaceId}`)
  out.push(T('ETL pipeline', 'etl-pipelines', etl.id, `/etl-pipelines/${etl.id}`))

  const [preset] = await http.get(`/schema-presets?workspaceId=${workspaceId}`)
  out.push(T('schema preset', 'schema-presets', preset.id, `/schema-presets/${preset.id}`, 'put',
    async () => (await http.get(`/schema-presets?workspaceId=${workspaceId}`)).find((p: { id: string }) => p.id === preset.id)))

  const [database] = await http.get(`/data-sources?workspaceId=${workspaceId}`)
  out.push(T('database', 'databases', database.id, `/data-sources/${database.id}`))

  const pluginId = `plugin-${tag}`
  const manifest = { id: `e2e-plugin-${tag}`, name: { en: `Plugin ${tag}` }, version: '0.1.0', type: 'lab' }
  await http.send('post', '/user-plugins', { id: pluginId, entityId: `e2e-plugin-${tag}`, workspaceId, files: { 'plugin.json': JSON.stringify(manifest, null, 2) } })
  out.push(T('plugin', 'user-plugins', pluginId, `/user-plugins/${pluginId}`))

  // Account-level settings: no README — the colleague edits a user's profile in
  // users.json, and a proposal changes it here. Not the signed-in administrator:
  // a pull never rewrites one's own account.
  const member = `member-${tag}`
  const user = await http.send('post', '/users', { username: member, password: `pw-${tag}-Aa1!`, role: 'user' })
  out.push({
    label: 'settings', scope: 'settings', id: 'account', workspaceId, colleagueFile: 'users.json',
    // As the export writes it (JSON.stringify(…, null, 2), no final newline), so the
    // re-exported file matches the colleague's byte for byte.
    colleagueEdit: (content, note) => JSON.stringify(
      (JSON.parse(content) as { username: string; lastName?: string | null }[])
        .map((u) => (u.username === member ? { ...u, lastName: note } : u)),
      null, 2,
    ),
    link: async (remote) => { await http.send('put', '/git/settings/account/config', remote) },
    readme: async (text) => { await http.send('patch', `/users/${user.id}`, { firstName: text.trim() }) },
  })
  return only ? out.filter((t) => t.label === only) : out
}

async function demoWorkspace(http: Http): Promise<string> {
  const workspaces: { id: string; name: { en?: string } }[] = await http.get('/workspaces')
  const ws = workspaces.find((w) => w.name.en === 'Demo workspace')
  expect(ws, 'the demo workspace').toBeTruthy()
  return ws!.id
}

test('every kind of entity: push, a colleague’s change pulled, the same on another branch', async ({ page, request }, testInfo) => {
  test.skip(!process.env.E2E_DEMO || !process.env.E2E_GIT_LOCAL_REMOTES, 'needs the demo workspace and local git remotes')
  test.setTimeout(1_800_000)
  await signIn(page)
  const http = await api(page, request)
  const workspaceId = await demoWorkspace(http)

  for (const t of await targets(http, workspaceId)) {
    await test.step(t.label, async () => {
      const remote = testInfo.outputPath(`${t.scope}-${run}.git`)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
      await t.link({ url: `file://${remote}`, branch: 'main' })
      expect((await http.git(`/${t.scope}/${t.id}/commit-push`, { message: 'First push', branch: 'main' })).pushed, `${t.label}: first push`).toBe(true)
      expect.soft(await leftToCommit(http, t, 'main'), `${t.label}: clean after the push`).toEqual([])

      // A colleague's README change comes back and leaves nothing to commit.
      const clone = testInfo.outputPath(`${t.scope}-${run}-colleague`)
      const readme = t.colleagueFile
      colleagueEdits(`file://${remote}`, clone, 'main', readme, `Colleague paragraph for ${t.label}.`, t.colleagueEdit)
      expect((await http.get(`/git/${t.scope}/${t.id}/sync-state?branch=main`)).behind, `${t.label}: behind`).toBe(true)
      const pulled = await pullEverything(page, t, 'main')
      expect.soft(pulled, `${t.label}: the README came in`).toContain(readme)
      expect.soft(await leftToCommit(http, t, 'main'), `${t.label}: clean after the pull`).toEqual([])
      expect.soft((await http.get(`/git/${t.scope}/${t.id}/sync-state?branch=main`)).behind, `${t.label}: up to date`).toBe(false)

      // Another branch: pushed there, changed there, pulled from there.
      await http.git(`/${t.scope}/${t.id}/commit-push`, { message: 'Branch push', branch: 'e2e-branch' })
      colleagueEdits(`file://${remote}`, clone, 'e2e-branch', readme, `Branch paragraph for ${t.label}.`, t.colleagueEdit)
      await pullEverything(page, t, 'e2e-branch')
      expect.soft(await leftToCommit(http, t, 'e2e-branch'), `${t.label}: clean on the branch after its pull`).toEqual([])
    })
  }
})

test('every kind of entity: a change proposed as a merge request, merged on the forge, then pulled', async ({ page, request }) => {
  test.skip(!process.env.E2E_DEMO || !process.env.E2E_FORGE, 'needs the demo workspace and docker/forge-sim')
  test.setTimeout(1_800_000)
  await signIn(page)
  const http = await api(page, request)
  const workspaceId = await demoWorkspace(http)
  const alice = readFileSync(path.join(FORGE_TOKENS, 'alice'), 'utf-8').trim()
  const bob = readFileSync(path.join(FORGE_TOKENS, 'bob'), 'utf-8').trim()
  const forge = (token: string, method: string, url: string, data?: unknown) =>
    request.fetch(`${FORGE}/api/v4${url}`, { method, headers: { 'PRIVATE-TOKEN': token }, data })
  await http.send('put', '/git/host-token', { url: `${FORGE}/sandbox/x.git`, token: alice })
  const group = (await (await forge(alice, 'GET', '/groups?search=sandbox')).json())[0]

  for (const t of await targets(http, workspaceId)) {
    await test.step(t.label, async () => {
      const name = `${t.scope}-${run}`
      const created = await forge(alice, 'POST', '/projects', { name, path: name, namespace_id: group.id, initialize_with_readme: false })
      expect(created.ok(), await created.text()).toBe(true)
      const project = await created.json()
      await t.link({ url: `${FORGE}/sandbox/${name}.git`, branch: 'main' })
      expect((await http.git(`/${t.scope}/${t.id}/commit-push`, { message: 'First push', branch: 'main' })).pushed, `${t.label}: first push`).toBe(true)

      await t.readme(`Proposed in Linkr for ${t.label}.\n`)
      const status = await http.git(`/${t.scope}/${t.id}/status`, { branch: 'main' })
      const paths = (status.files as { path: string }[]).map((f) => f.path)
      expect(paths, `${t.label}: the README change to propose`).not.toEqual([])
      const proposal = await http.git(`/${t.scope}/${t.id}/propose`, { title: `${t.label}: README`, branch: 'main', paths })
      expect(proposal.state).toBe('open')

      // Bob merges it on GitLab (mergeability is computed asynchronously).
      let merged = false
      for (let i = 0; i < 30 && !merged; i++) {
        const r = await forge(bob, 'PUT', `/projects/${project.id}/merge_requests/${proposal.number}/merge`)
        merged = r.ok()
        if (!merged) await page.waitForTimeout(2000)
      }
      expect(merged, `${t.label}: merged on the forge`).toBe(true)
      const listed = await http.get(`/git/${t.scope}/${t.id}/proposals`)
      expect(listed[0].state).toBe('merged')

      await pullEverything(page, t, 'main')
      expect.soft(await leftToCommit(http, t, 'main'), `${t.label}: nothing left once the merge is pulled`).toEqual([])
    })
  }
})

test('the workspace: an inline project a colleague removes, then brings back, follows through the pull', async ({ page, request }, testInfo) => {
  test.skip(!process.env.E2E_DEMO || !process.env.E2E_GIT_LOCAL_REMOTES, 'needs the demo workspace and local git remotes')
  test.setTimeout(600_000)
  await signIn(page)
  const http = await api(page, request)
  const workspaceId = await demoWorkspace(http)
  const [ws] = (await targets(http, workspaceId)).filter((t) => t.scope === 'workspaces')
  const folder = ws.colleagueFile.split('/').slice(0, 2).join('/')
  const entityId = folder.split('/')[1]
  const inline = async () => (await http.get(`/projects?workspaceId=${workspaceId}`))
    .filter((p: { entityId?: string }) => p.entityId === entityId)

  const remote = testInfo.outputPath(`workspace-inline-${run}.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  await ws.link({ url: `file://${remote}`, branch: 'main' })
  expect((await http.git(`/workspaces/${workspaceId}/commit-push`, { message: 'First push', branch: 'main' })).pushed).toBe(true)

  const clone = testInfo.outputPath(`workspace-inline-${run}-colleague`)
  execFileSync('git', ['clone', '-q', `file://${remote}`, clone])
  git(clone, 'config', 'user.name', 'Colleague')
  git(clone, 'config', 'user.email', 'colleague@example.org')
  git(clone, 'rm', '-q', '-r', folder)
  git(clone, 'commit', '-q', '-m', 'Colleague: remove the inline project')
  git(clone, 'push', '-q', 'origin', 'HEAD:main')

  await pullEverything(page, ws, 'main')
  expect.soft(await inline(), 'the project left with its folder').toEqual([])
  expect.soft(await leftToCommit(http, ws, 'main'), 'clean after the removal').toEqual([])

  git(clone, 'revert', '--no-edit', 'HEAD')
  git(clone, 'push', '-q', 'origin', 'HEAD:main')
  await pullEverything(page, ws, 'main')
  expect.soft(await inline(), 'the project came back with its folder').toHaveLength(1)
  expect.soft(await leftToCommit(http, ws, 'main'), 'clean after it came back').toEqual([])
})
