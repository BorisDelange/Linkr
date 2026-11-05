/**
 * The wiki part of a workspace import, onto a real IndexedDB storage whose
 * attachment store refuses what the server refuses: an attachment of a page
 * that does not exist, a second one at the same page and file name.
 */
import 'fake-indexeddb/auto'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createIDBStorage } from '@/lib/storage/idb-storage'
import { initStorage, type Storage } from '@/lib/storage'
import { parseWorkspaceZip, type ParsedWorkspaceZip } from './entity-io'
import { importWorkspaceTree } from './workspace-import'

let storage: Storage
beforeAll(() => {
  const local = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => { local.set(k, v) },
    removeItem: (k: string) => { local.delete(k) },
  })
  const base = createIDBStorage()
  const attachments = base.wikiAttachments
  storage = {
    ...base,
    wikiAttachments: Object.assign(Object.create(attachments), {
      create: async (att: Parameters<typeof attachments.create>[0]) => {
        if (!(await base.wikiPages.getById(att.pageId))) throw new Error('404 Page not found')
        if (await attachments.getById(att.id)) throw new Error('IntegrityError: duplicate id')
        await attachments.create(att)
      },
    }),
  }
  initStorage(storage)
})

async function parse(zip: JSZip): Promise<ParsedWorkspaceZip> {
  zip.file('entity.json', JSON.stringify({ name: { en: 'W' }, description: { en: '' }, type: 'workspace' }))
  return (await parseWorkspaceZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File))!
}

describe('workspace import — wiki attachments', () => {
  it('lands one attachment per page and file name from a tree that listed one twice', async () => {
    const zip = new JSZip()
    zip.file('wiki/_tree.json', JSON.stringify([{ entityId: 'home', title: { en: 'Home' } }]))
    zip.file('wiki/home.md', '# Home')
    const entry = { pageEntityId: 'home', fileName: 'a.png', mimeType: 'image/png', fileSize: 1 }
    zip.file('wiki/_attachments/_meta.json', JSON.stringify([entry, { ...entry, createdAt: '2026-01-02T00:00:00.000Z' }]))
    zip.file('wiki/_attachments/home/a.png', 'a')
    const { targetWsId } = await importWorkspaceTree(await parse(zip), { duplicate: false, language: 'en' })
    expect((await storage.wikiAttachments.getByWorkspace(targetWsId)).map((a) => a.fileName)).toEqual(['a.png'])
  })

  it('skips an attachment whose page the import did not land', async () => {
    const zip = new JSZip()
    zip.file('wiki/_tree.json', JSON.stringify([{ entityId: 'home', title: { en: 'Home' } }]))
    zip.file('wiki/home.md', '# Home')
    zip.file('wiki/_attachments/_meta.json', JSON.stringify([{ pageEntityId: 'home', fileName: 'a.png', mimeType: 'image/png', fileSize: 1 }]))
    zip.file('wiki/_attachments/home/a.png', 'a')
    const parsed = await parse(zip)
    parsed.wikiAttachmentsMeta.push({ ...parsed.wikiAttachmentsMeta[0], id: 'gone/b.png', pageId: 'gone', fileName: 'b.png' })
    parsed.wikiAttachmentBlobs.set('gone/b.png', new ArrayBuffer(1))
    const { targetWsId } = await importWorkspaceTree(parsed, { duplicate: false, language: 'en' })
    expect((await storage.wikiAttachments.getByWorkspace(targetWsId)).map((a) => a.fileName)).toEqual(['a.png'])
  })
})
