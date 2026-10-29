import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, signIn } from '../fixtures'

// Two people on one workspace repository. The remote is a bare repository on this
// machine, which the server only accepts with LINKR_GIT_ALLOW_LOCAL_REMOTES=true
// (a dev-only switch): without it the journey is skipped. The API is the page's
// origin unless E2E_API_URL names it (a dev stack serves it on its own port).
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })

async function api(page: Page, request: APIRequestContext) {
  const base = process.env.E2E_API_URL ?? new URL(page.url()).origin
  const token = await page.evaluate(() => localStorage.getItem('linkr-access-token'))
  expect(token, 'access token in the page').toBeTruthy()
  const headers = { Authorization: `Bearer ${token}` }
  const ok = async (res: Promise<import('@playwright/test').APIResponse>) => {
    const r = await res
    expect(r.ok(), `${r.url()} → ${r.status()} ${await r.text()}`).toBe(true)
    return r
  }
  return {
    get: (url: string) => ok(request.get(`${base}/api/v1${url}`, { headers })),
    post: (url: string, data: unknown) => ok(request.post(`${base}/api/v1${url}`, { headers, data })),
    patch: (url: string, data: unknown) => ok(request.patch(`${base}/api/v1${url}`, { headers, data })),
    push: (wsId: string) => ok(request.post(`${base}/api/v1/git/workspaces/${wsId}/commit-push`, {
      headers, multipart: { message: 'First push', branch: 'main' },
    })),
  }
}

// Page ids are global on an instance: suffixed per run, so a rerun on a kept one never collides.
const run = Date.now()
const page1 = { id: `e2e-setup-${run}`, entityId: 'setup', title: { en: 'Setup' }, slug: 'setup', sortOrder: 0 }
const page2 = { id: `e2e-faq-${run}`, entityId: 'faq', title: { en: 'FAQ' }, slug: 'faq', sortOrder: 1 }

test('a colleague’s wiki edits come back through the pull, page by page and item by item', async ({ page, request }, testInfo) => {
  test.skip(!process.env.E2E_GIT_LOCAL_REMOTES, 'needs a server started with LINKR_GIT_ALLOW_LOCAL_REMOTES=true')
  await signIn(page)
  const name = `E2E pull ${run}`
  await page.goto('./workspaces')
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.getByLabel('Workspace name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  const wsUrl = page.url().replace(/\/home$/, '')

  // The workspace, its wiki and its remote, set up through the API.
  const remote = testInfo.outputPath('remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const http = await api(page, request)
  // The URL carries the workspace's short uid; the API wants its id.
  const workspaces: { id: string; name: { en?: string } }[] = await (await http.get('/workspaces')).json()
  const wsId = workspaces.find((w) => w.name.en === name)!.id
  for (const [p, content] of [[page1, 'Install it.\n\nRun it.\n'], [page2, 'Question one.\n\nAnswer one.\n']] as const) {
    await http.post('/wiki-pages', { ...p, workspaceId: wsId, parentId: null, content: { en: content } })
  }
  await http.patch(`/workspaces/${wsId}`, { gitRemoteConfig: { url: `file://${remote}`, branch: 'main' } })
  await http.push(wsId)

  // The colleague: status + a paragraph at the end of Setup, FAQ's first paragraph, a new page.
  const clone = testInfo.outputPath('colleague')
  execFileSync('git', ['clone', '-q', remote, clone])
  git(clone, 'config', 'user.name', 'Colleague')
  git(clone, 'config', 'user.email', 'colleague@example.org')
  const treePath = path.join(clone, 'wiki', '_tree.json')
  const tree = JSON.parse(readFileSync(treePath, 'utf-8'))
  tree.find((p: { id: string }) => p.id === page1.id).status = 'needs_revision'
  // A page as a Linkr export writes it: every key of an existing entry, in its
  // order, createdAt included; the tree sorted by id.
  const blank = Object.fromEntries(Object.keys(tree[0]).map((k) => [k, null]))
  tree.push({ ...blank, id: `e2e-note-${run}`, entityId: 'note', title: { en: 'Note' }, slug: 'note', sortOrder: 2, createdAt: '2026-01-02T03:04:05.000Z' })
  tree.sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1))
  writeFileSync(treePath, JSON.stringify(tree, null, 2))
  writeFileSync(path.join(clone, 'wiki', 'setup.md'), 'Install it.\n\nRun it.\n\nThen check the logs.\n')
  writeFileSync(path.join(clone, 'wiki', 'faq.md'), 'Question one, theirs.\n\nAnswer one.\n')
  mkdirSync(path.join(clone, 'wiki'), { recursive: true })
  writeFileSync(path.join(clone, 'wiki', 'note.md'), 'A note from the colleague.\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-q', '-m', 'Colleague edits')
  git(clone, 'push', '-q', 'origin', 'main')

  // Meanwhile, here: Setup's first paragraph (merges cleanly) and FAQ's (conflicts).
  await http.patch(`/wiki-pages/${page1.id}`, { content: { en: 'Install it with uv.\n\nRun it.\n' } })
  await http.patch(`/wiki-pages/${page2.id}`, { content: { en: 'Question one, mine.\n\nAnswer one.\n' } })

  await page.goto(`${wsUrl}/versioning?tab=git`)
  // Quick actions: one card, counts, and no bulk take while a conflict is open.
  await expect(page.getByText('Pull all')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/1 conflict/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Take', exact: true })).toBeDisabled()
  // …but each file can be taken or left on its own, except where a conflict needs Details.
  await page.getByRole('button', { name: 'Take wiki/note.md' }).click()
  await expect(page.getByRole('button', { name: 'Take wiki/note.md' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Take wiki/faq.md' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Keep mine wiki/faq.md' })).toBeEnabled()
  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'pull-quick.png'), fullPage: true })

  // Details: a row per page, an item per field or language.
  await page.getByRole('tab', { name: 'Details' }).click()
  for (const file of ['wiki/setup.md', 'wiki/faq.md', 'wiki/note.md']) {
    await expect(page.getByRole('button', { name: new RegExp(file.replace('.', '\\.')) })).toBeVisible()
  }
  await expect(page.getByText('merged with your edits')).toBeVisible()

  // The diff of Setup shows the merged content on the right.
  await page.getByRole('button', { name: /wiki\/setup\.md/ }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Then check the logs.')).toBeVisible()
  await expect(dialog.getByText('Install it with uv.').first()).toBeVisible()
  await page.keyboard.press('Escape')

  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'pull-details.png'), fullPage: true })

  // Decide row by row and item by item: Setup and Note taken, FAQ's conflicting content kept.
  const row = (file: string) => page.getByRole('listitem').filter({ hasText: file })
  await row('wiki/setup.md').getByRole('button', { name: 'Take all' }).first().click()
  await row('wiki/note.md').getByRole('button', { name: 'Take all' }).first().click()
  await row('wiki/faq.md').getByRole('button', { name: 'Keep mine' }).last().click()
  await page.getByRole('button', { name: 'Apply and finish' }).click()

  // Back to pushing: our own edits are left to send — Setup merged with ours, FAQ
  // kept — while what came in (the new page, the tree) already matches the remote.
  await expect(page.getByText('0 added · 2 modified · 0 deleted')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('wiki/faq.md')).toBeVisible()
  await expect(page.getByText('wiki/setup.md')).toBeVisible()
  await expect(page.getByText('wiki/_tree.json')).toHaveCount(0)
  await expect(page.getByText('wiki/note.md')).toHaveCount(0)
  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'after-pull.png'), fullPage: true })

  const pages: { id: string; status?: string; content: { en: string } }[] = await (await http.get(`/wiki-pages?workspaceId=${wsId}`)).json()
  const byId = new Map(pages.map((p) => [p.id, p]))
  expect(byId.get(page1.id)?.status).toBe('needs_revision')
  expect(byId.get(page1.id)?.content.en).toBe('Install it with uv.\n\nRun it.\n\nThen check the logs.\n')
  expect(byId.get(page2.id)?.content.en).toBe('Question one, mine.\n\nAnswer one.\n')
  expect(byId.get(`e2e-note-${run}`)?.content.en).toBe('A note from the colleague.\n')
})
