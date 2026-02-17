import { useState, useEffect, useRef, useCallback } from 'react'
import { getStorage } from '@/lib/storage'
import type { WikiAttachment } from '@/types'

/**
 * Hook for managing wiki page attachments (CRUD, blob URLs, markdown resolution).
 */
export function useWikiAttachments(pageId: string | null, workspaceId: string) {
  const [attachments, setAttachments] = useState<WikiAttachment[]>([])
  const [loading, setLoading] = useState(false)
  const blobUrlsRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (pageId) loadAttachments()
    return () => {
      for (const url of blobUrlsRef.current.values()) {
        URL.revokeObjectURL(url)
      }
      blobUrlsRef.current.clear()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  const loadAttachments = useCallback(async () => {
    if (!pageId) return
    setLoading(true)
    try {
      const items = await getStorage().wikiAttachments.getByPage(pageId)
      setAttachments(items)
      for (const url of blobUrlsRef.current.values()) {
        URL.revokeObjectURL(url)
      }
      blobUrlsRef.current.clear()
      for (const att of items) {
        const blob = new Blob([att.data], { type: att.mimeType })
        blobUrlsRef.current.set(att.fileName, URL.createObjectURL(blob))
      }
    } finally {
      setLoading(false)
    }
  }, [pageId])

  const uploadAttachment = useCallback(async (file: File) => {
    if (!pageId) return
    const data = await file.arrayBuffer()
    const attachment: WikiAttachment = {
      id: `watt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pageId,
      workspaceId,
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      data,
      createdAt: new Date().toISOString(),
    }
    await getStorage().wikiAttachments.create(attachment)
    const blob = new Blob([data], { type: file.type })
    blobUrlsRef.current.set(file.name, URL.createObjectURL(blob))
    setAttachments((prev) => [...prev, attachment])
    return attachment
  }, [pageId, workspaceId])

  const deleteAttachment = useCallback(async (id: string) => {
    const att = attachments.find((a) => a.id === id)
    if (att) {
      const url = blobUrlsRef.current.get(att.fileName)
      if (url) {
        URL.revokeObjectURL(url)
        blobUrlsRef.current.delete(att.fileName)
      }
    }
    await getStorage().wikiAttachments.delete(id)
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [attachments])

  const resolveAttachmentUrls = useCallback((markdown: string): string => {
    if (!markdown) return markdown
    let result = markdown.replace(
      /!\[([^\]]*)\]\(attachments\/([^)]+)\)/g,
      (_match, alt: string, fileName: string) => {
        const blobUrl = blobUrlsRef.current.get(fileName)
        if (blobUrl) return `![${alt}](${blobUrl})`
        return _match
      },
    )
    result = result.replace(
      /(<img\s[^>]*?)src="attachments\/([^"]+)"([^>]*?>)/g,
      (_match, before: string, fileName: string, after: string) => {
        const blobUrl = blobUrlsRef.current.get(fileName)
        if (blobUrl) return `${before}src="${blobUrl}"${after}`
        return _match
      },
    )
    return result
  }, [])

  return {
    attachments,
    loading,
    uploadAttachment,
    deleteAttachment,
    resolveAttachmentUrls,
    reload: loadAttachments,
  }
}
