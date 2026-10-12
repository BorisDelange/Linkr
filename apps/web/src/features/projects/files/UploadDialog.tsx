import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '@/stores/file-store'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { FileSource } from '@/components/ui/file-source'
import { copyIdeFileFromServer, writeIdeFileBytes } from '@/lib/api/ide-files'
import { isServerMode } from '@/lib/api-client'
import { readTextUnlessBinary } from '@/lib/binary-file'
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

/** Files read and waiting on the user's answer about clashing names. A server
 *  pick has no content to read: the server copies its bytes once the name is
 *  settled. */
/** A local file's content as read: its text, or its bytes when it is binary —
 *  those are written as-is by the server instead of going through the editor. */
type LocalContent = string | Blob

type Pending =
  | { kind: 'local'; candidates: UploadCandidate<LocalContent>[]; conflicts: string[] }
  | { kind: 'server'; serverPath: string; candidate: UploadCandidate; conflicts: string[] }

export function UploadDialog({
  open,
  onOpenChange,
  parentId,
}: UploadDialogProps) {
  const { t } = useTranslation()
  const { createFileWithContent, updateFileContent, saveFile, reloadFromDisk, activeProjectUid } = useFileStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  /** Existing siblings — clashes are per FOLDER: the same name in two folders is
   *  two distinct paths in the export tree. */
  const siblings = (): ExistingFile[] =>
    useFileStore.getState().files
      .filter((f) => f.parentId === parentId && f.type === 'file')
      .map((f) => ({ id: f.id, name: f.name }))

  // An import only adds files to the tree; it does not open them — a binary one
  // would land in the editor as if it were a script.
  const finish = () => {
    setPending(null)
    onOpenChange(false)
  }

  const apply = async (candidates: UploadCandidate<LocalContent>[], resolution: ConflictResolution) => {
    setBusy(true)
    setError(null)
    try {
      const plan = planUpload(candidates, siblings(), resolution)
      const projectUid = activeProjectUid ?? ''
      let wroteBytes = false

      // Replacing UPDATES the existing file, so its id survives — and with it the
      // versioning mark (keyed by path), its open tab and any undo pointing at it.
      // Bytes overwrite the same path, which keeps the id just the same.
      for (const r of plan.replaces) {
        if (typeof r.content === 'string') {
          updateFileContent(r.id, r.content)
          await saveFile(r.id)
        } else {
          await writeIdeFileBytes({ projectUid, parentId, name: r.name, bytes: r.content })
          wroteBytes = true
        }
      }
      // Sequential, not Promise.all: in server mode each create re-scans the disk,
      // and concurrent re-scans race over the ids they return.
      for (const c of plan.creates) {
        if (typeof c.content === 'string') {
          await createFileWithContent(c.name, parentId, c.content)
        } else {
          await writeIdeFileBytes({ projectUid, parentId, name: c.name, bytes: c.content })
          wroteBytes = true
        }
      }
      if (wroteBytes) await reloadFromDisk(projectUid)
      finish()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** The server copies the bytes itself, so a binary file arrives intact. The
   *  name is settled by the same plan as an upload; replacing overwrites the
   *  file under its own name, which keeps its path — and so its id. */
  const applyServer = async (serverPath: string, candidate: UploadCandidate, resolution: ConflictResolution) => {
    setBusy(true)
    setError(null)
    try {
      const plan = planUpload([candidate], siblings(), resolution)
      const name = plan.replaces[0]?.name ?? plan.creates[0].name
      const projectUid = activeProjectUid ?? ''
      await copyIdeFileFromServer({ projectUid, serverPath, parentId, name })
      await reloadFromDisk(projectUid)
      finish()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const candidates: UploadCandidate<LocalContent>[] = []
      const rejected: string[] = []
      const binaryRejected: string[] = []
      for (const file of files) {
        // Upload was the one entry point taking the browser's name verbatim: a
        // directory drop could nest via `sub/file.sql`, and README.md/LICENSE.md/
        // attachments could land at the root, where the export overwrites them
        // from the entity's own fields and the uploaded file quietly vanishes.
        const safe = safeUploadFileName(file.name, parentId)
        if (!safe) {
          rejected.push(file.name)
          continue
        }
        const text = await readTextUnlessBinary(file)
        if (text !== null) {
          candidates.push({ name: safe, content: text })
        } else if (isServerMode()) {
          candidates.push({ name: safe, content: file })
        } else {
          // Front-only files are stored as text: a binary one would be saved
          // corrupted, so it is refused rather than accepted and broken.
          binaryRejected.push(file.name)
        }
      }
      if (rejected.length > 0) {
        setError(t('files.upload_rejected', { names: rejected.join(', ') }))
        return
      }
      if (binaryRejected.length > 0) {
        setError(t('files.upload_binary_unsupported', { names: binaryRejected.join(', ') }))
        return
      }
      const conflicts = findConflicts(candidates, siblings())
      // Nothing to decide: straight through, so the common case is unchanged.
      if (conflicts.length === 0) {
        await apply(candidates, 'keep-both')
        return
      }
      setPending({ kind: 'local', candidates, conflicts })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleServerPick = async (serverPath: string) => {
    setError(null)
    const safe = safeUploadFileName(serverPath, parentId)
    if (!safe) {
      setError(t('files.upload_rejected', { names: serverPath }))
      return
    }
    const candidate = { name: safe, content: '' }
    const conflicts = findConflicts([candidate], siblings())
    if (conflicts.length === 0) {
      await applyServer(serverPath, candidate, 'keep-both')
      return
    }
    setPending({ kind: 'server', serverPath, candidate, conflicts })
  }

  const resolve = (resolution: ConflictResolution) => {
    if (!pending) return
    if (pending.kind === 'local') void apply(pending.candidates, resolution)
    else void applyServer(pending.serverPath, pending.candidate, resolution)
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
      onConfirm={pending ? () => resolve('replace') : undefined}
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
          onClick={() => resolve('keep-both')}
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
                <li key={name} className="truncate font-mono text-[10px]">{name}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t('files.upload_conflict_hint')}</p>
          </div>
        ) : (
          <div className="mt-4">
            <FileSource
              scope={{ kind: 'project-import', projectUid: activeProjectUid ?? '', target: 'ide' }}
              expect="file"
              serverPath=""
              onServerPathChange={(path) => { if (path) void handleServerPick(path) }}
            >
              <div className="space-y-2">
                <Label>{t('files.upload_from_computer')}</Label>
                <FileDropZone
                  icon={busy
                    ? <Loader2 size={20} className="animate-spin text-muted-foreground" />
                    : <Upload size={20} className="text-muted-foreground" />}
                  label={t('files.upload_drop_hint')}
                  onClick={() => inputRef.current?.click()}
                  onDropFiles={(files) => void handleFiles(files)}
                  disabled={busy}
                />
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void handleFiles(Array.from(e.target.files ?? []))
                    // Cleared so re-picking the same file fires change again.
                    e.target.value = ''
                  }}
                />
              </div>
            </FileSource>
          </div>
        )}
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </DialogShell>
  )
}
