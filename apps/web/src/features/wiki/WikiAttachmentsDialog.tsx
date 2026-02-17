import { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Copy, Check, Trash2, Image as ImageIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { WikiAttachment } from '@/types'

interface WikiAttachmentsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  attachments: WikiAttachment[]
  onUpload: (file: File) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

const ACCEPTED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
  'image/webp',
]

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function WikiAttachmentsDialog({
  open,
  onOpenChange,
  attachments,
  onUpload,
  onDelete,
}: WikiAttachmentsDialogProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setUploading(true)
      try {
        for (const file of Array.from(files)) {
          if (ACCEPTED_TYPES.includes(file.type)) {
            await onUpload(file)
          }
        }
      } finally {
        setUploading(false)
      }
    },
    [onUpload],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const copyMarkdown = useCallback((fileName: string) => {
    const md = `<img src="attachments/${fileName}" alt="${fileName}" width="300" />`
    navigator.clipboard.writeText(md)
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('summary.attachments')}</DialogTitle>
        </DialogHeader>

        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={(e) => { e.preventDefault(); setDragOver(false) }}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 transition-colors ${
            dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
          }`}
        >
          <Upload size={20} className={dragOver ? 'text-primary' : 'text-muted-foreground'} />
          <span className="text-xs text-muted-foreground">
            {uploading ? t('summary.uploading') : t('summary.drop_files')}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_TYPES.join(',')}
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                handleFiles(e.target.files)
                e.target.value = ''
              }
            }}
          />
        </div>

        {attachments.length > 0 && (
          <div className="mt-2 max-h-64 space-y-2 overflow-auto">
            {attachments.map((att) => (
              <AttachmentRow
                key={att.id}
                attachment={att}
                onCopy={() => copyMarkdown(att.fileName)}
                onDelete={() => onDelete(att.id)}
              />
            ))}
          </div>
        )}

        {attachments.length === 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t('summary.no_attachments')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AttachmentRow({
  attachment,
  onCopy,
  onDelete,
}: {
  attachment: WikiAttachment
  onCopy: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const isImage = attachment.mimeType.startsWith('image/')
  const [thumbnailUrl] = useState(() => {
    if (isImage) {
      const blob = new Blob([attachment.data], { type: attachment.mimeType })
      return URL.createObjectURL(blob)
    }
    return null
  })

  const handleCopy = () => {
    onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt={attachment.fileName} className="h-full w-full object-cover" />
        ) : (
          <ImageIcon size={16} className="text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{attachment.fileName}</p>
        <p className="text-[11px] text-muted-foreground">
          {formatFileSize(attachment.fileSize)}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className={`h-6 w-6 p-0 ${copied ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
        title={t('summary.copy_markdown')}
        onClick={handleCopy}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
        title={t('summary.delete_attachment')}
        onClick={onDelete}
      >
        <Trash2 size={12} />
      </Button>
    </div>
  )
}
