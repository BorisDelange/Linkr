import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Loader2 } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Button } from '@/components/ui/button'
import { useEtlStore } from '@/stores/etl-store'
import { inferEtlLanguage, nextEtlOrder, safeEtlFileName } from './etl-file-language'
import {
  findConflicts,
  planUpload,
  type ConflictResolution,
  type ExistingFile,
  type UploadCandidate,
} from '@/lib/upload-conflicts'
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

  /** Files read and sanitised, waiting on the user's answer about clashes. */
  const [pending, setPending] = useState<{ candidates: UploadCandidate[]; conflicts: string[] } | null>(null)

  /** Existing siblings — clashes are per FOLDER, not per pipeline: two files with
   *  the same name in different folders are distinct paths in the export tree. */
  const siblings = (): ExistingFile[] => {
    const { files } = useEtlStore.getState()
    return files
      .filter((f) => f.pipelineId === pipelineId && f.parentId === parentId && f.type === 'file')
      .map((f) => ({ id: f.id, name: f.name }))
  }

  const apply = async (candidates: UploadCandidate[], resolution: ConflictResolution) => {
    setBusy(true)
    setError(null)
    try {
      const { files, createFile, updateFile, selectFile } = useEtlStore.getState()
      const plan = planUpload(candidates, siblings(), resolution)
      let order = nextEtlOrder(files.filter((f) => f.pipelineId === pipelineId))
      let lastId: string | null = null

      // Replacing UPDATES in place, so the file keeps its id — and with it its
      // versioning mark, its place in the run order, and any history pointing at it.
      for (const r of plan.replaces) {
        await updateFile(r.id, { content: r.content, language: inferEtlLanguage(r.name) })
        lastId = r.id
      }
      for (const c of plan.creates) {
        const created: EtlFile = {
          id: crypto.randomUUID(),
          pipelineId,
          name: c.name,
          type: 'file',
          parentId,
          content: c.content,
          language: inferEtlLanguage(c.name),
          order: order++,
          createdAt: new Date().toISOString(),
        }
        await createFile(created)
        lastId = created.id
      }

      if (lastId) selectFile(lastId)
      setPending(null)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const candidates: UploadCandidate[] = []
      const rejected: string[] = []
      for (const file of Array.from(fileList)) {
        const safe = safeEtlFileName(file.name)
        if (!safe) {
          rejected.push(file.name)
          continue
        }
        candidates.push({ name: safe, content: await file.text() })
      }
      if (rejected.length > 0) {
        setError(t('etl.upload_rejected', { names: rejected.join(', ') }))
        return
      }

      const conflicts = findConflicts(candidates, siblings())
      // Nothing to decide: go straight through, so the common case is unchanged.
      if (conflicts.length === 0) {
        await apply(candidates, 'keep-both')
        return
      }
      setPending({ candidates, conflicts })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => { if (!busy) { setError(null); if (!next) setPending(null); onOpenChange(next) } }}
      title={t('etl.upload_files')}
      description={t('etl.upload_files_description')}
      cancelLabel={t('common.cancel')}
      onConfirm={pending ? () => void apply(pending.candidates, 'replace') : undefined}
      confirmLabel={t('files.upload_replace')}
      /* Destructive styling: it overwrites a script's contents, and the previous
         version is not kept anywhere. */
      destructive
      busy={busy}
      footerExtra={pending && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void apply(pending.candidates, 'keep-both')}
        >
          {t('files.upload_keep_both')}
        </Button>
      )}
    >
        {pending ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm">
              {t('files.upload_conflict_intro', { count: pending.conflicts.length })}
            </p>
            {/* The names, so the choice is made against real files rather than a
                bare count — replacing the wrong script is not recoverable. */}
            <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded bg-muted/50 p-2">
              {pending.conflicts.map((name) => (
                <li key={name} className="truncate font-mono text-[11px]">{name}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t('files.upload_conflict_hint')}</p>
          </div>
        ) : (
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
        )}
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
    </DialogShell>
  )
}
