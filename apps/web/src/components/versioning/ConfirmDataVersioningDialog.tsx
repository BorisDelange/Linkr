import { useCallback, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { GitPullRequest, UploadCloud } from 'lucide-react'
import { ChangeBadge } from './ChangeBadge'

interface DataFileEntry {
  path: string
  changeType?: string
}

/** What the push the dialog gates will do: commit and push, or propose. */
export type DataPushAction = 'push' | 'propose'

interface PendingConfirm {
  kind: 'mark' | DataPushAction
  files: DataFileEntry[]
  deleted: DataFileEntry[]
  apply: () => void
}

/**
 * Gate for data files reaching the remote, at the two moments it is decided:
 * - `requestMark(paths, apply)` when a file is marked "to version" (it leaves the
 *   gitignore). Unmarking needs no gate — call the store directly for it.
 * - `requestPush(files, apply, action, deleted)` before a commit+push — or a
 *   proposal, which pushes too — that carries data files, since a mark made once
 *   is not consent for every later version of the file. The confirm button names
 *   the action the user started. `deleted` lists the files the push removes from
 *   the remote that the export may have left out (see leftOutFilesToDelete).
 *
 * Both list the exact files; data files require an explicit acknowledgement. Then
 * `apply` runs; with nothing to list it runs at once.
 */
export function useConfirmDataVersioning(): {
  requestMark: (paths: string[], apply: () => void) => void
  requestPush: (files: DataFileEntry[], apply: () => void, action?: DataPushAction, deleted?: DataFileEntry[]) => void
  dialog: ReactNode
} {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [open, setOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const checkboxId = useId()

  const request = useCallback(
    (kind: PendingConfirm['kind'], files: DataFileEntry[], apply: () => void, deleted: DataFileEntry[] = []) => {
      if (files.length === 0 && deleted.length === 0) {
        apply()
        return
      }
      const sorted = (list: DataFileEntry[]) => [...list].sort((a, b) => a.path.localeCompare(b.path))
      setAcknowledged(false)
      setPending({ kind, files: sorted(files), deleted: sorted(deleted), apply })
      setOpen(true)
    },
    [],
  )

  const requestMark = useCallback(
    (paths: string[], apply: () => void) => request('mark', paths.map((path) => ({ path })), apply),
    [request],
  )
  const requestPush = useCallback(
    (files: DataFileEntry[], apply: () => void, action: DataPushAction = 'push', deleted: DataFileEntry[] = []) =>
      request(action, files, apply, deleted),
    [request],
  )

  // `pending` outlives the close so the list does not empty mid-animation.
  const close = () => setOpen(false)

  const count = pending?.files.length ?? 0
  const deletedCount = pending?.deleted.length ?? 0
  const needsAck = count > 0

  const handleConfirm = () => {
    if (!open || !pending || (needsAck && !acknowledged)) return
    pending.apply()
    close()
  }

  const isPush = pending?.kind === 'push' || pending?.kind === 'propose'
  const confirmLabel = pending?.kind === 'propose'
    ? <><GitPullRequest size={14} />{t('versioning.propose')}</>
    : isPush
      ? <><UploadCloud size={14} />{t('versioning.confirm_push_data_action', { count })}</>
      : t('versioning.confirm_data_action', { count })
  const title = !isPush
    ? t('versioning.confirm_data_title', { count })
    : needsAck
      ? t('versioning.confirm_push_data_title', { count })
      : t('versioning.confirm_push_deleted_title', { count: deletedCount })

  const fileList = (files: DataFileEntry[]) => (
    <ul className="max-h-48 space-y-0.5 overflow-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
      {files.map((f) => (
        <li key={f.path} className="flex items-start gap-2">
          {f.changeType ? <ChangeBadge changeType={f.changeType} /> : <span className="shrink-0">•</span>}
          <span className="min-w-0 break-all">{f.path}</span>
        </li>
      ))}
    </ul>
  )

  const dialog = (
    <DialogShell
      open={open}
      onOpenChange={(next) => { if (!next) close() }}
      kind="settings"
      title={title}
      onConfirm={handleConfirm}
      confirmLabel={confirmLabel}
      confirmDisabled={needsAck && !acknowledged}
    >
      {needsAck && (
        <>
          <NoticeBanner
            tone="warning"
            title={t('versioning.confirm_data_warning', { count })}
            description={t(isPush ? 'versioning.confirm_push_data_hint' : 'versioning.confirm_data_hint')}
          />
          {fileList(pending?.files ?? [])}
          <div className="flex items-start gap-2">
            <Checkbox
              id={checkboxId}
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor={checkboxId} className="leading-snug">
              {t('versioning.confirm_data_checkbox')}
            </Label>
          </div>
        </>
      )}
      {deletedCount > 0 && (
        <>
          <NoticeBanner
            tone="warning"
            title={t('versioning.confirm_push_deleted_warning', { count: deletedCount })}
            description={t('versioning.confirm_push_deleted_hint')}
          />
          {fileList(pending?.deleted ?? [])}
        </>
      )}
    </DialogShell>
  )

  return { requestMark, requestPush, dialog }
}
