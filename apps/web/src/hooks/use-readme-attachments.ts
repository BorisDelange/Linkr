import { useMemo, useCallback } from 'react'
import { getStorage } from '@/lib/storage'
import { useAttachments } from './use-attachments'
import type { ReadmeAttachment, ReadmeOwnerType } from '@/types'

/**
 * README attachments (CRUD, blob URLs, markdown resolution) for any entity that
 * owns a README. `workspaceId` is denormalized onto each attachment so deleting a
 * workspace cascades to everything it contains, whatever the owner type.
 */
export function useReadmeAttachments(
  ownerType: ReadmeOwnerType,
  ownerId: string,
  workspaceId?: string,
) {
  const storage = useMemo(() => ({
    load: () => getStorage().readmeAttachments.getByOwner(ownerType, ownerId),
    create: (att: ReadmeAttachment) => getStorage().readmeAttachments.create(att),
    delete: (id: string) => getStorage().readmeAttachments.delete(id),
  }), [ownerType, ownerId])

  const buildAttachment = useCallback((file: File, data: ArrayBuffer): ReadmeAttachment => ({
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ownerType,
    ownerId,
    workspaceId: ownerType === 'workspace' ? ownerId : workspaceId,
    fileName: file.name,
    mimeType: file.type,
    fileSize: file.size,
    data,
    createdAt: new Date().toISOString(),
  }), [ownerType, ownerId, workspaceId])

  return useAttachments<ReadmeAttachment>({
    scopeKey: `${ownerType}:${ownerId}`,
    storage,
    buildAttachment,
  })
}
