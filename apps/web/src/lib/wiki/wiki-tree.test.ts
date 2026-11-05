import { describe, expect, it } from 'vitest'
import type { WikiAttachment, WikiPage } from '@/types'
import { buildWikiAttachmentMeta, buildWikiTree, readWikiAttachmentMeta, readWikiTree, wikiPageId } from './wiki-tree'

const page = (over: Partial<WikiPage>): WikiPage => ({
  id: 'x', workspaceId: 'ws1', parentId: null, title: { en: 'X' }, slug: 'x', content: {}, sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', ...over,
})
const strip = ({ workspaceId: _w, updatedAt: _u, ...rest }: Record<string, unknown>) => rest

describe('buildWikiTree', () => {
  it('names pages and parents by entityId, carries no local id, sorts by entityId', () => {
    const tree = buildWikiTree([
      page({ id: 'u2', entityId: 'setup', parentId: 'u1', lineageId: 'L2' }),
      page({ id: 'u1', entityId: 'home', lineageId: 'L1' }),
    ], strip)
    expect(tree.map((e) => e.entityId)).toEqual(['home', 'setup'])
    expect(tree[1]).toMatchObject({ entityId: 'setup', lineageId: 'L2', parentEntityId: 'home' })
    for (const e of tree) {
      expect(e).not.toHaveProperty('id')
      expect(e).not.toHaveProperty('parentId')
      expect(e).not.toHaveProperty('workspaceId')
    }
  })

  it('writes the same tree whatever the local ids', () => {
    const a = buildWikiTree([page({ id: 'a1', entityId: 'home' }), page({ id: 'a2', entityId: 'faq', parentId: 'a1' })], strip)
    const b = buildWikiTree([page({ id: 'b2', entityId: 'faq', parentId: 'b1' }), page({ id: 'b1', entityId: 'home' })], strip)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('omits an absent lineage, null or missing', () => {
    const [e] = buildWikiTree([page({ id: 'u1', entityId: 'home', lineageId: null as unknown as string })], strip)
    expect(e).not.toHaveProperty('lineageId')
  })
})

describe('readWikiTree', () => {
  it('keys pages by entityId until the import lands them', () => {
    const pages = readWikiTree([
      { entityId: 'home', parentEntityId: null, title: { en: 'Home' } },
      { entityId: 'faq', parentEntityId: 'home', title: { en: 'FAQ' } },
    ])
    expect(pages.map((p) => [p.id, p.parentId])).toEqual([['home', null], ['faq', 'home']])
  })

  it('resolves the parent of an older entry through its id', () => {
    const pages = readWikiTree([
      { id: 'u1', entityId: 'home', parentId: null, title: { en: 'Home' } },
      { id: 'u2', parentId: 'u1', title: { en: 'FAQ' } },
    ])
    expect(pages.map((p) => [p.id, p.parentId])).toEqual([['home', null], ['faq--u2', 'home']])
  })

  it('lands the same ids for the same workspace, different ones elsewhere', () => {
    expect(wikiPageId('ws1', 'home')).toBe(wikiPageId('ws1', 'home'))
    expect(wikiPageId('ws1', 'home')).not.toBe(wikiPageId('ws2', 'home'))
  })
})

describe('wiki attachments', () => {
  const att = (over: Partial<WikiAttachment>): Omit<WikiAttachment, 'data'> => ({
    id: 'a', pageId: 'u1', workspaceId: 'ws1', fileName: 'f.png', mimeType: 'image/png', fileSize: 4,
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  })

  it('names an attachment by its page entityId and file name, dropping orphans', () => {
    const pages = [page({ id: 'u1', entityId: 'home' })]
    const meta = buildWikiAttachmentMeta([att({ id: 'z', fileName: 'b.png' }), att({ id: 'y', fileName: 'a.png' }), att({ pageId: 'gone' })], pages)
    expect(meta).toEqual([
      { pageEntityId: 'home', fileName: 'a.png', mimeType: 'image/png', fileSize: 4, createdAt: '2026-01-01T00:00:00.000Z' },
      { pageEntityId: 'home', fileName: 'b.png', mimeType: 'image/png', fileSize: 4, createdAt: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('reads both layouts back', () => {
    const tree = readWikiTree([{ entityId: 'home', title: { en: 'Home' } }])
    expect(readWikiAttachmentMeta([{ pageEntityId: 'home', fileName: 'a.png', mimeType: 'image/png', fileSize: 4 }], tree, [])[0])
      .toMatchObject({ pageId: 'home', path: 'wiki/_attachments/home/a.png' })
    const oldTree = [{ id: 'u1', entityId: 'home', title: { en: 'Home' } }]
    expect(readWikiAttachmentMeta([{ id: 'wa1', pageId: 'u1', fileName: 'a.png' }], readWikiTree(oldTree), oldTree)[0])
      .toMatchObject({ pageId: 'home', path: 'wiki/_attachments/wa1-a.png' })
  })
})
