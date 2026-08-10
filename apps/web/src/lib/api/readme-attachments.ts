import { apiFetch, apiRequest } from '@/lib/api-client'
import type { ReadmeAttachmentStorage } from '@/lib/storage'
import type { ReadmeAttachment } from '@/types'

const BASE = '/readme-attachments'

/** Metadata as returned by the API (no binary — that comes from /{id}/blob). */
type Meta = Omit<ReadmeAttachment, 'data'>

async function withData(meta: Meta): Promise<ReadmeAttachment> {
  const res = await apiFetch(`/api/v1${BASE}/${meta.id}/blob`)
  const data = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0)
  return { ...meta, data }
}

function ownerQuery(ownerType: string, ownerId: string): string {
  return `ownerType=${encodeURIComponent(ownerType)}&ownerId=${encodeURIComponent(ownerId)}`
}

/**
 * Server-mode README attachment storage. Metadata lives in the DB; the binary
 * is a content-addressed blob fetched per-attachment so the `data: ArrayBuffer`
 * contract (consumed by use-attachments to build blob URLs) is preserved.
 */
export const apiReadmeAttachmentStorage: ReadmeAttachmentStorage = {
  getByOwner: async (ownerType, ownerId) => {
    const metas = await apiRequest<Meta[]>(`${BASE}?${ownerQuery(ownerType, ownerId)}`)
    return Promise.all(metas.map(withData))
  },

  // No caller uses getById for attachments (loads are always by owner).
  getById: async () => undefined,

  create: async (att) => {
    const qs = new URLSearchParams({
      id: att.id,
      fileName: att.fileName,
      mimeType: att.mimeType,
      ownerType: att.ownerType,
      ownerId: att.ownerId,
    })
    if (att.createdAt) qs.set('createdAt', att.createdAt)
    await apiFetch(`/api/v1${BASE}?${qs}`, { method: 'POST', body: att.data })
  },

  delete: async (id) => {
    await apiRequest(`${BASE}/${id}`, { method: 'DELETE' })
  },

  deleteByOwner: async (ownerType, ownerId) => {
    await apiRequest(`${BASE}?${ownerQuery(ownerType, ownerId)}`, { method: 'DELETE' })
  },

  deleteByWorkspace: async (workspaceId) => {
    await apiRequest(`${BASE}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
  },
}
