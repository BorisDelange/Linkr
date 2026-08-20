import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '@/stores/file-store'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Button } from '@/components/ui/button'
import { Upload, Loader2 } from 'lucide-react'
import {
  findConflicts,
  planUpload,
  safeUploadFileName,
  type ConflictResolution,
  type ExistingFile,
  type UploadCandidate,
} from '@/lib/upload-conflicts'

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

export function UploadDialog({
  open,
  onOpenChange,
  parentId,
}: UploadDialogProps) {
  const { t } = useTranslation()
  const { createFileWithContent, updateFileContent, saveFile, selectFile } = useFileStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Files read and waiting on the user's answer about clashing names. */
  const [pending, setPending] = useState<{ candidates: UploadCandidate[]; conflicts: string[] } | null>(null)

  /** Existing siblings — clashes are per FOLDER: the same name in two folders is
   *  two distinct paths in the export tree. */
  const siblings = (): ExistingFile[] =>
    useFileStore.getState().files
      .filter((f) => f.parentId === parentId && f.type === 'file')
      .map((f) => ({ id: f.id, name: f.name }))

  const apply = async (candidates: UploadCandidate[], resolution: ConflictResolution) => {
    setBusy(true)
    setError(null)
    try {
      const plan = planUpload(candidates, siblings(), resolution)
      let lastId: string | null = null

      // Replacing UPDATES the existing file, so its id survives — and with it the
      // versioning mark (keyed by path), its open tab and any undo pointing at it.
      for (const r of plan.replaces) {
        updateFileContent(r.id, r.content)
        await saveFile(r.id)
        lastId = r.id
      }
      // Sequential, not Promise.all: in server mode each create re-scans the disk,
      // and concurrent re-scans race over the ids they return.
      for (const c of plan.creates) {
        const id = await createFileWithContent(c.name, parentId, c.content)
        if (id) lastId = id
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
        // Upload was the one entry point taking the browser's name verbatim: a
        // directory drop could nest via `sub/file.sql`, and README.md/LICENSE.md/
        // attachments could land at the root, where the export overwrites them
        // from the entity's own fields and the uploaded file quietly vanishes.
        const safe = safeUploadFileName(file.name, parentId)
        if (!safe) {
          rejected.push(file.name)
          continue
        }
        candidates.push({ name: safe, content: await file.text() })
      }
      if (rejected.length > 0) {
        setError(t('files.upload_rejected', { names: rejected.join(', ') }))
        return
      }
      const conflicts = findConflicts(candidates, siblings())
      // Nothing to decide: straight through, so the common case is unchanged.
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

  const close = () => {
    setPending(null)
    setError(null)
    onOpenChange(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => { if (!busy) { if (!next) close(); else onOpenChange(next) } }}
      title={t('files.upload')}
      description={t('files.upload_description')}
      cancelLabel={t('common.cancel')}
      onConfirm={pending ? () => void apply(pending.candidates, 'replace') : undefined}
      confirmLabel={t('files.upload_replace')}
      /* Destructive styling: it overwrites a file's contents, and the previous
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
                bare count — replacing the wrong file is not recoverable. */}
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
              dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
            }`}
            onClick={() => { if (!busy) inputRef.current?.click() }}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!busy) setDragActive(true)
            }}
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
            <p className="mt-3 text-sm text-muted-foreground">
              {t('files.upload_drop')}
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
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </DialogShell>
  )
}
