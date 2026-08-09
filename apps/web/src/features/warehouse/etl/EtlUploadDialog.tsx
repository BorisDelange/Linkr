import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useEtlStore } from '@/stores/etl-store'
import { inferEtlLanguage, safeEtlFileName, uniqueEtlFileName } from './etl-file-language'
import type { EtlFile } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  pipelineId: string
  /** Folder to drop the files into; null is the pipeline root. */
  parentId?: string | null
}

/**
 * Add existing scripts to a pipeline, by picker or drag and drop.
 *
 * Files are read as text — a pipeline holds scripts, and `EtlFile.content` is
 * text in the store and in the database, so a binary upload has nowhere to go.
 */
export function EtlUploadDialog({ open, onOpenChange, pipelineId, parentId = null }: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const { files, createFile, selectFile } = useEtlStore.getState()
      // Names are reserved as we go, so two uploads in one drop cannot collide
      // with each other — only checking the store would let both take one name.
      const taken = files.filter((f) => f.pipelineId === pipelineId).map((f) => f.name)
      let order = files.filter((f) => f.pipelineId === pipelineId).length
      let lastId: string | null = null
      const rejected: string[] = []

      for (const file of Array.from(fileList)) {
        const safe = safeEtlFileName(file.name)
        if (!safe) {
          rejected.push(file.name)
          continue
        }
        const name = uniqueEtlFileName(safe, taken)
        taken.push(name)
        const created: EtlFile = {
          id: crypto.randomUUID(),
          pipelineId,
          name,
          type: 'file',
          parentId,
          content: await file.text(),
          language: inferEtlLanguage(name),
          order: order++,
          createdAt: new Date().toISOString(),
        }
        await createFile(created)
        lastId = created.id
      }

      if (rejected.length > 0) {
        setError(t('etl.upload_rejected', { names: rejected.join(', ') }))
        return
      }
      if (lastId) selectFile(lastId)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) { setError(null); onOpenChange(next) } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('etl.upload_files')}</DialogTitle>
          <DialogDescription>{t('etl.upload_files_description')}</DialogDescription>
        </DialogHeader>
        <div
          className={`mt-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
            busy ? 'cursor-default opacity-60' : 'cursor-pointer'
          } ${
            dragActive
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-muted-foreground/50'
          }`}
          onClick={() => { if (!busy) inputRef.current?.click() }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) setDragActive(true) }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragActive(false)
            if (!busy) void handleFiles(e.dataTransfer.files)
          }}
        >
          {busy
            ? <Loader2 size={32} className="animate-spin text-muted-foreground/50" />
            : <Upload size={32} className="text-muted-foreground/50" />}
          <p className="mt-3 text-center text-sm text-muted-foreground">
            {t('etl.upload_files_drop')}
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFiles(e.target.files)
              // Cleared so re-picking the same file fires change again.
              e.target.value = ''
            }}
          />
        </div>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
        <DialogFooter className="mt-4">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
