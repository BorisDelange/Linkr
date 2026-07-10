import { apiFetch, apiRequest } from '@/lib/api-client'
import type { WikiAttachmentStorage } from '@/lib/storage'
import type { WikiAttachment } from '@/types'

const BASE = '/wiki-attachments'

type Meta = Omit<WikiAttachment, 'data'>

async function withData(meta: Meta): Promise<WikiAttachment> {
  const res = await apiFetch(`/api/v1${BASE}/${meta.id}/blob`)
  const data = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0)
  return { ...meta, data }
}

/** Server-mode wiki attachment storage — same blob-fetch pattern as README. */
export const apiWikiAttachmentStorage: WikiAttachmentStorage = {
  getByPage: async (pageId) => {
    const metas = await apiRequest<Meta[]>(`${BASE}?pageId=${encodeURIComponent(pageId)}`)
    return Promise.all(metas.map(withData))
  },

  getByWorkspace: async (workspaceId) => {
    const metas = await apiRequest<Meta[]>(`${BASE}?workspaceId=${encodeURIComponent(workspaceId)}`)
    return Promise.all(metas.map(withData))
  },

  // No caller uses getById for attachments (loads are always by parent).
  getById: async () => undefined,

  create: async (att) => {
    const qs = new URLSearchParams({
      id: att.id,
      pageId: att.pageId,
      workspaceId: att.workspaceId,
      fileName: att.fileName,
      mimeType: att.mimeType,
    })
    if (att.createdAt) qs.set('createdAt', att.createdAt)
    await apiFetch(`/api/v1${BASE}?${qs}`, { method: 'POST', body: att.data })
  },

  delete: async (id) => {
    await apiRequest(`${BASE}/${id}`, { method: 'DELETE' })
  },

  deleteByPage: async (pageId) => {
    await apiRequest(`${BASE}?pageId=${encodeURIComponent(pageId)}`, { method: 'DELETE' })
  },

  deleteByWorkspace: async (workspaceId) => {
    await apiRequest(`${BASE}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
  },
}
