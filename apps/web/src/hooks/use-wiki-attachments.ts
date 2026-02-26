import { useMemo, useCallback } from 'react'
import { getStorage } from '@/lib/storage'
import { useAttachments } from './use-attachments'
import type { WikiAttachment } from '@/types'

/**
 * Hook for managing wiki page attachments (CRUD, blob URLs, markdown resolution).
 */
export function useWikiAttachments(pageId: string | null, workspaceId: string) {
  const storage = useMemo(() => ({
    load: () => pageId ? getStorage().wikiAttachments.getByPage(pageId) : Promise.resolve([]),
    create: (att: WikiAttachment) => getStorage().wikiAttachments.create(att),
    delete: (id: string) => getStorage().wikiAttachments.delete(id),
  }), [pageId])

  const buildAttachment = useCallback((file: File, data: ArrayBuffer): WikiAttachment => ({
    id: `watt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pageId: pageId!,
    workspaceId,
    fileName: file.name,
    mimeType: file.type,
    fileSize: file.size,
    data,
    createdAt: new Date().toISOString(),
  }), [pageId, workspaceId])

  return useAttachments<WikiAttachment>({
    scopeKey: pageId,
    storage,
    buildAttachment,
  })
}
