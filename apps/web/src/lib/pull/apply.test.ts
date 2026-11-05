/**
 * Writing a pull onto a real IndexedDB storage (fake-indexeddb): the workspace
 * sections and entities a colleague adds, changes or removes upstream all land
 * locally, and the settings keep every account a pull would otherwise delete.
 */
import 'fake-indexeddb/auto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it } from 'vitest'
import { createIDBStorage } from '@/lib/storage/idb-storage'
import { initStorage, type Storage } from '@/lib/storage'
import { applyEntityPull, applyWorkspacePull, splitUnwritable } from './apply'
import type { Override, PreparedFile } from './three-way'

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'export-golden')
const WS = 'ws-pull'
const NOW = '2026-01-01T00:00:00.000Z'

/** A golden export tree under `prefix`, as a workspace export nests it. */
function golden(kind: string, zip: JSZip, prefix = ''): string[] {
  const root = join(GOLDEN, kind, 'expected')
  const paths: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        const path = `${prefix}${relative(root, full)}`
        zip.file(path, readFileSync(full))
        paths.push(path)
      }
    }
  }
  walk(root)
  return paths
}

/** Every path as taken from the remote: what the merged tree holds is what lands. */
const taken = (paths: string[]): Record<string, Override> => Object.fromEntries(paths.map((p) => [p, { remote: true }]))
const removed = (paths: string[]): Record<string, Override> => Object.fromEntries(paths.map((p) => [p, { delete: true }]))

let storage: Storage
beforeAll(() => {
  storage = createIDBStorage()
  initStorage(storage)
})

describe('splitUnwritable', () => {
  const users: PreparedFile = {
    file: { path: 'users.json' },
    merge: {
      kind: 'elements', keyField: 'username', base: [], local: [], remote: [],
      elements: [{ key: 'alice', state: 'delete' }, { key: 'bob', state: 'add' }],
    },
  }

  it('keeps a deleted account out of a settings pull and reports it', () => {
    const { prepared, unsupported } = splitUnwritable('settings', [users])
    expect(unsupported).toEqual(['users.json › alice'])
    expect(prepared[0].merge.kind === 'elements' && prepared[0].merge.elements.map((e) => e.key)).toEqual(['bob'])
  })

  it('keeps a change to the signed-in user’s own account out, as the settings import skips it', () => {
    const own: PreparedFile = { ...users, merge: { ...users.merge, elements: [{ key: 'me', state: 'update' }, { key: 'bob', state: 'add' }] } as PreparedFile['merge'] }
    expect(splitUnwritable('settings', [own], 'me').unsupported).toEqual(['users.json › me'])
  })

  it('leaves every other scope as it is', () => {
    expect(splitUnwritable('dq-rule-sets', [users])).toEqual({ prepared: [users], unsupported: [] })
  })
})

describe('workspace pull', () => {
  it('creates an inline rule set a colleague added, then removes it when its folder goes', async () => {
    const zip = new JSZip()
    const paths = golden('dq-rule-set', zip, 'data-quality/vitals-checks/')
    await applyWorkspacePull(WS, zip, taken(paths), storage)
    const [created] = await storage.dqRuleSets.getByWorkspace(WS)
    expect(created, 'the rule set was created').toBeTruthy()
    expect((await storage.dqCustomChecks.getByRuleSet(created.id)).length).toBeGreaterThan(0)

    // The preview carries the folder's manifest as this instance exported it: the
    // merged tree has none left once the removal is taken.
    const manifest = await zip.file('data-quality/vitals-checks/entity.json')!.async('string')
    const preview = { branch: 'main', remoteHead: 'r', files: [{ path: 'data-quality/vitals-checks/entity.json', local: manifest }] }
    await applyWorkspacePull(WS, new JSZip(), removed(paths), storage, preview)
    expect(await storage.dqRuleSets.getByWorkspace(WS)).toEqual([])
  })

  it('adds a plugin, then writes a colleague’s change to its files over it', async () => {
    const zip = new JSZip()
    const paths = golden('user-plugin', zip, 'plugins/my-plugin/')
    await applyWorkspacePull(WS, zip, taken(paths), storage)
    const [plugin] = await storage.userPlugins.getByWorkspace(WS)
    expect(plugin?.files['plugin.json']).toBeTruthy()

    const changed = new JSZip()
    golden('user-plugin', changed)
    changed.file('extra.R.template', 'cat("hi")\n')
    await applyEntityPull('user-plugins', plugin.id, changed, taken(['extra.R.template']), WS, storage)
    const after = await storage.userPlugins.getById(plugin.id)
    expect(after?.files['extra.R.template']).toBe('cat("hi")\n')
    expect(after?.workspaceId).toBe(WS)
  })

  it('writes concept sets and service mappings file by file, and the badge ranges as one list', async () => {
    const zip = new JSZip()
    zip.file('concept-sets/heart-rate.json', JSON.stringify({ id: 'cs-1', name: 'Heart rate', concepts: [], createdAt: NOW }))
    zip.file('service-mappings/icu.json', JSON.stringify({ id: 'sm-1', name: 'ICU', createdAt: NOW }))
    zip.file('source-concept-ids/ranges.json', JSON.stringify([{ badgeLabel: 'RENNES', start: 2000000001, end: 2000001000 }]))
    await applyWorkspacePull(WS, zip, taken(['concept-sets/heart-rate.json', 'service-mappings/icu.json', 'source-concept-ids/ranges.json']), storage)
    expect((await storage.conceptSets.getByWorkspace(WS)).map((c) => c.name)).toEqual(['Heart rate'])
    expect((await storage.serviceMappings.getByWorkspace(WS)).map((s) => s.name)).toEqual(['ICU'])
    expect((await storage.sourceConceptIdRanges.getByWorkspace(WS)).map((r) => r.badgeLabel)).toEqual(['RENNES'])

    // A local-only field the export never carries survives an upstream edit.
    await storage.conceptSets.update('cs-1', { dictionaryId: 'dict-local' } as never)
    const edited = new JSZip()
    edited.file('concept-sets/heart-rate.json', JSON.stringify({ id: 'cs-1', name: 'Heart rate', description: 'bpm', concepts: [], createdAt: NOW }))
    await applyWorkspacePull(WS, edited, taken(['concept-sets/heart-rate.json']), storage)
    const [cs] = await storage.conceptSets.getByWorkspace(WS)
    expect(cs).toMatchObject({ description: 'bpm', dictionaryId: 'dict-local' })

    await applyWorkspacePull(WS, new JSZip(), removed(['concept-sets/heart-rate.json', 'service-mappings/icu.json']), storage)
    expect(await storage.conceptSets.getByWorkspace(WS)).toEqual([])
    expect(await storage.serviceMappings.getByWorkspace(WS)).toEqual([])
  })

  it('keeps the ids of sets imported before dictionaries were pointers, when the remote turns them into one', async () => {
    const ws = 'ws-dict-transition'
    const repo = 'https://github.com/example/dictionary'
    const set = (id: string, uniqueId: string, name: string) => ({
      id, workspaceId: ws, name, description: '', expression: { items: [] }, sourceUrl: `concept_sets/${uniqueId}.json`,
      uniqueId, sourceRepo: repo, createdAt: NOW, updatedAt: NOW,
    }) as never
    await storage.conceptSets.create(set('cs-hr', 'hr', 'Heart rate'))
    await storage.conceptSets.create(set('cs-gone', 'gone', 'Dropped upstream'))
    const zip = new JSZip()
    zip.file('data-dictionaries/_dictionaries.json', JSON.stringify([{ entityId: 'dictionary', name: 'Dictionary', git: { url: repo, branch: 'main' } }]))
    zip.file('data-dictionaries/dictionary/concept_sets/1.json', JSON.stringify({
      name: 'Heart rate', expression: { items: [] }, metadata: { uniqueId: 'hr', sourceRepo: repo },
    }))
    await applyWorkspacePull(ws, zip, {
      ...taken(['data-dictionaries/_dictionaries.json', 'data-dictionaries/dictionary/concept_sets/1.json']),
      ...removed(['concept-sets/heart-rate.json', 'concept-sets/dropped-upstream.json']),
    }, storage)
    const [dictionary] = await storage.dataDictionaries.getByWorkspace(ws)
    const sets = await storage.conceptSets.getByWorkspace(ws)
    expect(sets.map((s) => [s.id, s.dictionaryId])).toEqual([['cs-hr', dictionary.id]])
  })

  it('removes a wiki page the remote deleted, never one created after the pull was prepared', async () => {
    const ws = 'ws-wiki'
    const page = (id: string) => ({
      id, workspaceId: ws, parentId: null, title: { en: id }, slug: id, content: { en: '' }, sortOrder: 0, createdAt: NOW, updatedAt: NOW,
    }) as never
    await storage.wikiPages.create(page('old'))
    await storage.wikiPages.create(page('new'))
    const preview = { branch: 'main', remoteHead: 'r', files: [{ path: 'wiki/_tree.json', local: JSON.stringify([{ id: 'old' }]) }] }
    const zip = new JSZip()
    zip.file('wiki/_tree.json', '[]')
    await applyWorkspacePull(ws, zip, taken(['wiki/_tree.json']), storage, preview)
    expect((await storage.wikiPages.getByWorkspace(ws)).map((p) => p.id)).toEqual(['new'])
  })

  it('lands the wiki attachments a colleague added, changed or removed, never one added after the pull was prepared', async () => {
    const ws = 'ws-wiki-att'
    await storage.wikiPages.create({
      id: 'p-home', workspaceId: ws, parentId: null, entityId: 'home', title: { en: 'Home' }, slug: 'home', content: { en: '' }, sortOrder: 0, createdAt: NOW, updatedAt: NOW,
    } as never)
    const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
    const att = (id: string, fileName: string, data: string) => ({
      id, pageId: 'p-home', workspaceId: ws, fileName, mimeType: 'image/png', fileSize: data.length, data: bytes(data), createdAt: NOW,
    })
    await storage.wikiAttachments.create(att('a-old', 'old.png', 'old'))
    await storage.wikiAttachments.create(att('a-chart', 'chart.png', 'v1'))
    await storage.wikiAttachments.create(att('a-mine', 'mine.png', 'mine'))
    const meta = (names: string[]) => JSON.stringify(names.map((fileName) => ({ pageEntityId: 'home', fileName, mimeType: 'image/png', fileSize: 2 })))
    const preview = { branch: 'main', remoteHead: 'r', files: [{ path: 'wiki/_attachments/_meta.json', local: meta(['chart.png', 'old.png']) }] }
    const zip = new JSZip()
    zip.file('wiki/_tree.json', JSON.stringify([{ entityId: 'home', title: { en: 'Home' } }]))
    zip.file('wiki/home.md', '')
    zip.file('wiki/_attachments/_meta.json', meta(['chart.png', 'logo.png', 'mine.png']))
    zip.file('wiki/_attachments/home/chart.png', 'v2')
    zip.file('wiki/_attachments/home/logo.png', 'logo')
    zip.file('wiki/_attachments/home/mine.png', 'mine')
    await applyWorkspacePull(ws, zip, taken(['wiki/_attachments/_meta.json', 'wiki/_attachments/home/chart.png', 'wiki/_attachments/home/logo.png']), storage, preview)
    const after = await storage.wikiAttachments.getByWorkspace(ws)
    const text = (a: { data: ArrayBuffer }) => new TextDecoder().decode(a.data)
    expect(after.map((a) => [a.pageId, a.fileName, text(a)]).sort()).toEqual([
      ['p-home', 'chart.png', 'v2'], ['p-home', 'logo.png', 'logo'], ['p-home', 'mine.png', 'mine'],
    ])
    expect(after.find((a) => a.fileName === 'mine.png')?.id).toBe('a-mine')
  })

  it('fails before writing anything when the dictionary index is malformed', async () => {
    const ws = 'ws-bad-index'
    const zip = new JSZip()
    zip.file('wiki/_tree.json', JSON.stringify([{ entityId: 'home', title: { en: 'Home' } }]))
    zip.file('wiki/home.md', '# Home')
    zip.file('data-dictionaries/_dictionaries.json', '[{')
    await expect(applyWorkspacePull(ws, zip, taken(['wiki/_tree.json', 'wiki/home.md', 'data-dictionaries/_dictionaries.json']), storage))
      .rejects.toThrow('data-dictionaries/_dictionaries.json')
    expect(await storage.wikiPages.getByWorkspace(ws)).toEqual([])
  })

  it('writes the badge ranges as a diff: updated, added and removed, the rest kept', async () => {
    const ws = 'ws-ranges'
    const range = (badgeLabel: string, rangeStart: number) => ({ workspaceId: ws, badgeLabel, rangeStart, rangeEnd: rangeStart + 9, nextId: rangeStart, createdAt: NOW, updatedAt: NOW })
    await storage.sourceConceptIdRanges.save(range('A', 2000000001))
    await storage.sourceConceptIdRanges.save(range('B', 2000000011))
    const zip = new JSZip()
    zip.file('source-concept-ids/ranges.json', JSON.stringify([range('B', 2000000021), range('C', 2000000031)]))
    await applyWorkspacePull(ws, zip, taken(['source-concept-ids/ranges.json']), storage)
    const after = (await storage.sourceConceptIdRanges.getByWorkspace(ws)).map((r) => [r.badgeLabel, r.rangeStart]).sort()
    expect(after).toEqual([['B', 2000000021], ['C', 2000000031]])
  })

  it('creates an entity whose lineage matches none here, even in a folder a local one would claim', async () => {
    const ws = 'ws-lineage'
    const zip = new JSZip()
    const paths = golden('dq-rule-set', zip, 'data-quality/icu-dq/')
    await applyWorkspacePull(ws, zip, taken(paths), storage)
    const [first] = await storage.dqRuleSets.getByWorkspace(ws)
    expect(first.lineageId).toBe('lin-1')

    const other = new JSZip()
    golden('dq-rule-set', other, 'data-quality/icu-dq/')
    const manifest = JSON.parse(await other.file('data-quality/icu-dq/entity.json')!.async('string'))
    other.file('data-quality/icu-dq/entity.json', JSON.stringify({ ...manifest, lineageId: 'lin-2' }))
    await applyWorkspacePull(ws, other, taken(['data-quality/icu-dq/entity.json']), storage)
    const all = await storage.dqRuleSets.getByWorkspace(ws)
    expect(all).toHaveLength(2)
    expect((await storage.dqRuleSets.getById(first.id))?.lineageId).toBe('lin-1')
  })
})
