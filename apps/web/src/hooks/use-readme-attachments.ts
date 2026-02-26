import { useMemo, useCallback } from 'react'
import { getStorage } from '@/lib/storage'
import { useAttachments } from './use-attachments'
import type { ReadmeAttachment } from '@/types'

/**
 * Hook for managing readme attachments (CRUD, blob URLs, markdown resolution).
 */
export function useReadmeAttachments(projectUid: string) {
  const storage = useMemo(() => ({
    load: () => getStorage().readmeAttachments.getByProject(projectUid),
    create: (att: ReadmeAttachment) => getStorage().readmeAttachments.create(att),
    delete: (id: string) => getStorage().readmeAttachments.delete(id),
  }), [projectUid])

  const buildAttachment = useCallback((file: File, data: ArrayBuffer): ReadmeAttachment => ({
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectUid,
    fileName: file.name,
    mimeType: file.type,
    fileSize: file.size,
    data,
    createdAt: new Date().toISOString(),
  }), [projectUid])

  return useAttachments<ReadmeAttachment>({
    scopeKey: projectUid,
    storage,
    buildAttachment,
  })
}
