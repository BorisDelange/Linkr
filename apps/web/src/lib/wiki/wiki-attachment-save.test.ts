import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createIDBStorage } from '@/lib/storage/idb-storage'
import { saveWikiAttachment } from './wiki-attachment-save'

describe('saveWikiAttachment', () => {
  it('replaces the page\'s attachment of the same file name, and only that one', async () => {
    const storage = createIDBStorage().wikiAttachments
    const att = (id: string, pageId: string, fileName: string) => ({
      id, pageId, workspaceId: 'ws', fileName, mimeType: 'image/png', fileSize: 1, data: new ArrayBuffer(1), createdAt: id,
    })
    await saveWikiAttachment(storage, att('1', 'p1', 'a.png'))
    await saveWikiAttachment(storage, att('2', 'p1', 'b.png'))
    await saveWikiAttachment(storage, att('3', 'p2', 'a.png'))
    await saveWikiAttachment(storage, att('4', 'p1', 'a.png'))
    expect((await storage.getByWorkspace('ws')).map((a) => a.id).sort()).toEqual(['2', '3', '4'])
  })
})
