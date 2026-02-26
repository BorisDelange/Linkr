import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Minimal shape required from an attachment record.
 */
interface BaseAttachment {
  id: string
  fileName: string
  mimeType: string
  fileSize: number
  data: ArrayBuffer
  createdAt: string
}

interface AttachmentStorageAdapter<T extends BaseAttachment> {
  /** Load all attachments for the current scope (project, wiki page, etc.) */
  load(): Promise<T[]>
  /** Persist a new attachment */
  create(attachment: T): Promise<void>
  /** Delete an attachment by id */
  delete(id: string): Promise<void>
}

interface UseAttachmentsOptions<T extends BaseAttachment> {
  /** Unique key that identifies the scope — changing it reloads attachments */
  scopeKey: string | null
  /** Storage adapter for CRUD operations */
  storage: AttachmentStorageAdapter<T>
  /** Build a new attachment record from a File + ArrayBuffer */
  buildAttachment(file: File, data: ArrayBuffer): T
}

/**
 * Generic hook for managing file attachments with blob URL lifecycle,
 * CRUD operations, and markdown path resolution.
 *
 * Used by both readme attachments and wiki attachments.
 */
export function useAttachments<T extends BaseAttachment>({
  scopeKey,
  storage,
  buildAttachment,
}: UseAttachmentsOptions<T>) {
  const [attachments, setAttachments] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const blobUrlsRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (scopeKey) loadAttachments()
    return () => {
      for (const url of blobUrlsRef.current.values()) {
        URL.revokeObjectURL(url)
      }
      blobUrlsRef.current.clear()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const loadAttachments = useCallback(async () => {
    if (!scopeKey) return
    setLoading(true)
    try {
      const items = await storage.load()
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
  }, [scopeKey, storage])

  const uploadAttachment = useCallback(async (file: File) => {
    if (!scopeKey) return
    const data = await file.arrayBuffer()
    const attachment = buildAttachment(file, data)
    await storage.create(attachment)
    const blob = new Blob([data], { type: file.type })
    blobUrlsRef.current.set(file.name, URL.createObjectURL(blob))
    setAttachments((prev) => [...prev, attachment])
    return attachment
  }, [scopeKey, storage, buildAttachment])

  const deleteAttachment = useCallback(async (id: string) => {
    const att = attachments.find((a) => a.id === id)
    if (att) {
      const url = blobUrlsRef.current.get(att.fileName)
      if (url) {
        URL.revokeObjectURL(url)
        blobUrlsRef.current.delete(att.fileName)
      }
    }
    await storage.delete(id)
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [attachments, storage])

  /**
   * Resolves `attachments/filename.png` paths in markdown to blob URLs.
   * Handles both ![alt](attachments/file) and <img src="attachments/file" ...> formats.
   */
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
