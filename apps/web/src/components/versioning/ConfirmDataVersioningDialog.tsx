import { useCallback, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

interface PendingMark {
  paths: string[]
  apply: () => void
}

/**
 * Gate for marking data files "to version": a marked file leaves the gitignore
 * and reaches the remote on the next push, so the user must see the exact list
 * and tick an explicit acknowledgement first. Unmarking needs no gate — call the
 * store directly for it.
 *
 * `requestMark(paths, apply)` runs `apply` only on confirmation; an empty
 * `paths` applies at once (nothing data-bearing is being added).
 */
export function useConfirmDataVersioning(): {
  requestMark: (paths: string[], apply: () => void) => void
  dialog: ReactNode
} {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingMark | null>(null)
  const [open, setOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const checkboxId = useId()

  const requestMark = useCallback((paths: string[], apply: () => void) => {
    if (paths.length === 0) {
      apply()
      return
    }
    setAcknowledged(false)
    setPending({ paths: [...paths].sort(), apply })
    setOpen(true)
  }, [])

  // `pending` outlives the close so the list does not empty mid-animation.
  const close = () => setOpen(false)

  const handleConfirm = () => {
    if (!open || !pending || !acknowledged) return
    pending.apply()
    close()
  }

  const dialog = (
    <DialogShell
      open={open}
      onOpenChange={(next) => { if (!next) close() }}
      kind="settings"
      title={t('versioning.confirm_data_title', { count: pending?.paths.length ?? 0 })}
      onConfirm={handleConfirm}
      confirmLabel={t('versioning.confirm_data_action', { count: pending?.paths.length ?? 0 })}
      confirmDisabled={!acknowledged}
    >
      <NoticeBanner
        tone="warning"
        title={t('versioning.confirm_data_warning', { count: pending?.paths.length ?? 0 })}
        description={t('versioning.confirm_data_hint')}
      />
      <ul className="max-h-48 list-disc space-y-0.5 overflow-auto rounded-md border bg-muted/30 py-2 pl-7 pr-3 font-mono text-xs">
        {pending?.paths.map((p) => (
          <li key={p} className="break-all">{p}</li>
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

  return { requestMark, dialog }
}
