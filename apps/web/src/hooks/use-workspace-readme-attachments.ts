import { useMemo, useCallback } from 'react'
import { getStorage } from '@/lib/storage'
import { useAttachments } from './use-attachments'
import type { ReadmeAttachment } from '@/types'

/**
 * Workspace-scoped README attachments — the workspace counterpart to
 * useReadmeAttachments (which is project-scoped). Same ReadmeAttachment entity,
 * keyed by workspaceId instead of projectUid.
 */
export function useWorkspaceReadmeAttachments(workspaceId: string) {
  const storage = useMemo(() => ({
    load: () => getStorage().readmeAttachments.getByWorkspace(workspaceId),
    create: (att: ReadmeAttachment) => getStorage().readmeAttachments.create(att),
    delete: (id: string) => getStorage().readmeAttachments.delete(id),
  }), [workspaceId])

  const buildAttachment = useCallback((file: File, data: ArrayBuffer): ReadmeAttachment => ({
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId,
    fileName: file.name,
    mimeType: file.type,
    fileSize: file.size,
    data,
    createdAt: new Date().toISOString(),
  }), [workspaceId])

  return useAttachments<ReadmeAttachment>({
    scopeKey: workspaceId,
    storage,
    buildAttachment,
  })
}
