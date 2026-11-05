import type { WikiAttachmentStorage } from '@/lib/storage'
import type { WikiAttachment } from '@/types'

/** Store an uploaded attachment, replacing the page's attachment of the same
 *  file name: both would be stored at one path in the export. */
export async function saveWikiAttachment(storage: WikiAttachmentStorage, attachment: WikiAttachment): Promise<void> {
  for (const old of await storage.getByPage(attachment.pageId)) {
    if (old.fileName === attachment.fileName && old.id !== attachment.id) await storage.delete(old.id)
  }
  await storage.create(attachment)
}
