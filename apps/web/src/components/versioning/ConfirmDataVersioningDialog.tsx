import { useCallback, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ChangeBadge } from './ChangeBadge'

interface DataFileEntry {
  path: string
  changeType?: string
}

interface PendingConfirm {
  kind: 'mark' | 'push'
  files: DataFileEntry[]
  apply: () => void
}

/**
 * Gate for data files reaching the remote, at the two moments it is decided:
 * - `requestMark(paths, apply)` when a file is marked "to version" (it leaves the
 *   gitignore). Unmarking needs no gate — call the store directly for it.
 * - `requestPush(files, apply)` before a commit+push that carries data files, since
 *   a mark made once is not consent for every later version of the file.
 *
 * Both list the exact files and require an explicit acknowledgement, then run
 * `apply`; an empty list applies at once.
 */
export function useConfirmDataVersioning(): {
  requestMark: (paths: string[], apply: () => void) => void
  requestPush: (files: DataFileEntry[], apply: () => void) => void
  dialog: ReactNode
} {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [open, setOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const checkboxId = useId()

  const request = useCallback((kind: PendingConfirm['kind'], files: DataFileEntry[], apply: () => void) => {
    if (files.length === 0) {
      apply()
      return
    }
    setAcknowledged(false)
    setPending({ kind, files: [...files].sort((a, b) => a.path.localeCompare(b.path)), apply })
    setOpen(true)
  }, [])

  const requestMark = useCallback(
    (paths: string[], apply: () => void) => request('mark', paths.map((path) => ({ path })), apply),
    [request],
  )
  const requestPush = useCallback(
    (files: DataFileEntry[], apply: () => void) => request('push', files, apply),
    [request],
  )

  // `pending` outlives the close so the list does not empty mid-animation.
  const close = () => setOpen(false)

  const handleConfirm = () => {
    if (!open || !pending || !acknowledged) return
    pending.apply()
    close()
  }

  const count = pending?.files.length ?? 0
  const isPush = pending?.kind === 'push'

  const dialog = (
    <DialogShell
      open={open}
      onOpenChange={(next) => { if (!next) close() }}
      kind="settings"
      title={t(isPush ? 'versioning.confirm_push_data_title' : 'versioning.confirm_data_title', { count })}
      onConfirm={handleConfirm}
      confirmLabel={t(isPush ? 'versioning.confirm_push_data_action' : 'versioning.confirm_data_action', { count })}
      confirmDisabled={!acknowledged}
    >
      <NoticeBanner
        tone="warning"
        title={t('versioning.confirm_data_warning', { count })}
        description={t(isPush ? 'versioning.confirm_push_data_hint' : 'versioning.confirm_data_hint')}
      />
      <ul className="max-h-48 space-y-0.5 overflow-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
        {pending?.files.map((f) => (
          <li key={f.path} className="flex items-start gap-2">
            {f.changeType ? <ChangeBadge changeType={f.changeType} /> : <span className="shrink-0">•</span>}
            <span className="min-w-0 break-all">{f.path}</span>
          </li>
        ))}
      </ul>
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
    </DialogShell>
  )

  return { requestMark, requestPush, dialog }
}
