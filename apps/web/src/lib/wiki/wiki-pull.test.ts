import { describe, expect, it } from 'vitest'
import type { WikiPage } from '@/types'
import type { GitTreePreview } from '@/lib/api/git'
import { itemIdFor, type PullDecision } from '@/lib/pull-plan'
import { applyWikiPull, buildWikiPullPlan, prepareWikiPull, type WikiPullWriter } from './wiki-pull'

const meta = (id: string, over: Partial<WikiPage> = {}) => ({
  id, entityId: id, parentId: null, title: { en: id }, slug: id, sortOrder: 0, ...over,
})

function tree(pages: { meta: ReturnType<typeof meta>; content?: Record<string, string> }[]): Record<string, string> {
  const files: Record<string, string> = { 'wiki/_tree.json': JSON.stringify(pages.map((p) => p.meta)) }
  for (const p of pages) {
    for (const [lang, text] of Object.entries(p.content ?? {})) {
      files[`wiki/${p.meta.entityId}${lang === 'en' ? '' : `.${lang}`}.md`] = text
    }
  }
  return files
}

const preview = (base: Record<string, string>, remote: Record<string, string>, extra: Partial<GitTreePreview> = {}): GitTreePreview => ({
  branch: 'main', remoteHead: 'r1', syncedOid: 'b1', base, remote, baseOids: {}, remoteOids: {}, ...extra,
})

const local = (id: string, content: Record<string, string>, over: Partial<WikiPage> = {}) =>
  ({ ...meta(id, over), content, workspaceId: 'ws', createdAt: '', updatedAt: '' }) as WikiPage

const labels = { page: 'Page', field: (f: string) => f, content: (l: string) => `content ${l}`, autoMerged: 'merged' }

function recorder() {
  const calls: { op: string; id: string; changes?: Partial<WikiPage> }[] = []
  const writer: WikiPullWriter = {
    create: async (p) => { calls.push({ op: 'create', id: p.id, changes: p }) },
    update: async (id, changes) => { calls.push({ op: 'update', id, changes }) },
    delete: async (id) => { calls.push({ op: 'delete', id }) },
  }
  return { calls, writer }
}

describe('prepareWikiPull', () => {
  const base = tree([{ meta: meta('home'), content: { en: 'Intro\n\nSteps\n' } }])

  it('offers a remote-only change as an update, and merges edits to different paragraphs', () => {
    const remote = tree([{ meta: meta('home', { status: 'approved' }), content: { en: 'Intro\n\nSteps, revised\n' } }])
    const prepared = prepareWikiPull(preview(base, remote), [local('home', { en: 'Intro, mine\n\nSteps\n' })])
    expect(prepared.pages).toHaveLength(1)
    const page = prepared.pages[0]
    expect(page.fields).toEqual([{ field: 'status', state: 'update' }])
    expect(page.contents[0].state).toBe('update')

    const plan = buildWikiPullPlan(prepared, 'main', labels)
    expect(plan.files[0].path).toBe('wiki/home.md')
    expect(plan.files[0].items.map((i) => i.key)).toEqual(['field:status', 'content:en'])
  })

  it('reports a conflict when both sides rewrote the same paragraph', () => {
    const remote = tree([{ meta: meta('home'), content: { en: 'Intro\n\nSteps (theirs)\n' } }])
    const prepared = prepareWikiPull(preview(base, remote), [local('home', { en: 'Intro\n\nSteps (mine)\n' })])
    expect(prepared.pages[0].contents[0].state).toBe('conflict')
  })

  it('stays quiet on a local-only change, which is ours to push', () => {
    const prepared = prepareWikiPull(preview(base, base), [local('home', { en: 'Intro\n\nSteps, mine\n' })])
    expect(prepared.pages).toEqual([])
  })

  it('adds a new remote page, and flags deleting a page edited here', () => {
    const remote = tree([{ meta: meta('faq'), content: { en: 'Q?' } }])
    const prepared = prepareWikiPull(preview(base, remote), [local('home', { en: 'Edited\n' })])
    expect(prepared.pages.map((p) => [p.id, p.kind])).toEqual([['faq', 'add'], ['home', 'delete-conflict']])
  })

  it('lists remote changes outside the wiki, which this pull does not take', () => {
    const prepared = prepareWikiPull(
      preview(base, base, { baseOids: { 'workspace.json': 'a' }, remoteOids: { 'workspace.json': 'b', 'sql-scripts/x.sql': 'c' } }),
      [local('home', { en: 'Intro\n\nSteps\n' })],
    )
    expect(prepared.otherChanges).toEqual(['sql-scripts/x.sql', 'workspace.json'])
  })
})

describe('applyWikiPull', () => {
  const base = tree([{ meta: meta('home'), content: { en: 'Intro\n\nSteps\n', fr: 'Intro FR\n' } }])
  const remote = tree([
    { meta: meta('home', { status: 'needs_revision' }), content: { en: 'Intro\n\nSteps, revised\n', fr: 'Intro FR revue\n' } },
    { meta: meta('faq'), content: { en: 'Q?\n' } },
  ])
  const prepared = prepareWikiPull(preview(base, remote), [local('home', { en: 'Intro, mine\n\nSteps\n', fr: 'Intro FR\n' })])

  it('writes the accepted items only, the merged content included', async () => {
    const decisions = new Map<string, PullDecision>([
      [itemIdFor('wiki/home.md', 'field:status'), 'accept'],
      [itemIdFor('wiki/home.md', 'content:en'), 'accept'],
      [itemIdFor('wiki/home.md', 'content:fr'), 'decline'],
      [itemIdFor('wiki/faq.md', 'page'), 'accept'],
    ])
    const { calls, writer } = recorder()
    await applyWikiPull(prepared, decisions, 'ws', writer)

    const update = calls.find((c) => c.op === 'update')!
    expect(update.changes?.status).toBe('needs_revision')
    expect(update.changes?.content).toEqual({ en: 'Intro, mine\n\nSteps, revised\n', fr: 'Intro FR\n' })
    const create = calls.find((c) => c.op === 'create')!
    expect(create.id).toBe('faq')
    expect(create.changes?.workspaceId).toBe('ws')
  })

  it('writes nothing when everything is declined', async () => {
    const decisions = new Map<string, PullDecision>()
    for (const file of buildWikiPullPlan(prepared, 'main', labels).files) {
      for (const item of file.items) decisions.set(itemIdFor(file.path, item.key), 'decline')
    }
    const { calls, writer } = recorder()
    await applyWikiPull(prepared, decisions, 'ws', writer)
    expect(calls).toEqual([])
  })
})
