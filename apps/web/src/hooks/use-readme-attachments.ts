import { useState, useEffect, useRef, useCallback } from 'react'
import { getStorage } from '@/lib/storage'
import type { ReadmeAttachment } from '@/types'

/**
 * Hook for managing readme attachments (CRUD, blob URLs, markdown resolution).
 */
export function useReadmeAttachments(projectUid: string) {
  const [attachments, setAttachments] = useState<ReadmeAttachment[]>([])
  const [loading, setLoading] = useState(false)
  const blobUrlsRef = useRef<Map<string, string>>(new Map())

  // Load attachments on mount
  useEffect(() => {
    loadAttachments()
    return () => {
      // Cleanup blob URLs on unmount
      for (const url of blobUrlsRef.current.values()) {
        URL.revokeObjectURL(url)
      }
      blobUrlsRef.current.clear()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectUid])

  const loadAttachments = useCallback(async () => {
    setLoading(true)
    try {
      const items = await getStorage().readmeAttachments.getByProject(projectUid)
      setAttachments(items)
      // Create blob URLs for each attachment
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
  }, [projectUid])

  const uploadAttachment = useCallback(async (file: File) => {
    const data = await file.arrayBuffer()
    const attachment: ReadmeAttachment = {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectUid,
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      data,
      createdAt: new Date().toISOString(),
    }
    await getStorage().readmeAttachments.create(attachment)
    // Create blob URL immediately
    const blob = new Blob([data], { type: file.type })
    blobUrlsRef.current.set(file.name, URL.createObjectURL(blob))
    setAttachments((prev) => [...prev, attachment])
    return attachment
  }, [projectUid])

  const deleteAttachment = useCallback(async (id: string) => {
    const att = attachments.find((a) => a.id === id)
    if (att) {
      const url = blobUrlsRef.current.get(att.fileName)
      if (url) {
        URL.revokeObjectURL(url)
        blobUrlsRef.current.delete(att.fileName)
      }
    }
    await getStorage().readmeAttachments.delete(id)
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [attachments])

  /**
   * Resolves `attachments/filename.png` paths in markdown to blob URLs.
   */
  const resolveAttachmentUrls = useCallback((markdown: string): string => {
    if (!markdown) return markdown
    return markdown.replace(
      /!\[([^\]]*)\]\(attachments\/([^)]+)\)/g,
      (_match, alt: string, fileName: string) => {
        const blobUrl = blobUrlsRef.current.get(fileName)
        if (blobUrl) {
          return `![${alt}](${blobUrl})`
        }
        return _match
      },
    )
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
