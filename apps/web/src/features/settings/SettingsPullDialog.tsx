import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { toGitError } from '@/lib/git-error-message'
import {
  settingsPullPreview,
  settingsImportRemote,
  type SettingsPullPreview,
  type SettingsImportReport,
} from '@/lib/api/settings-versioning'

interface SettingsPullDialogProps {
  branch?: string
  onClose: () => void
  onApplied: (report: SettingsImportReport) => void
}

type Family = 'organizations' | 'users' | 'roles'
const FAMILIES: Family[] = ['organizations', 'users', 'roles']

/**
 * Pull settings (organizations / users / roles) from the linked git remote, with a
 * per-family choice — the same shape as the mapping-project pull dialog, but with
 * upsert semantics (no 3-way merge): each family is applied wholesale or skipped.
 */
export function SettingsPullDialog({ branch, onClose, onApplied }: SettingsPullDialogProps) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<SettingsPullPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Record<Family, boolean>>({ organizations: true, users: true, roles: true })
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    settingsPullPreview(branch)
      .then((p) => {
        if (cancelled) return
        setPreview(p)
        // Default-select only families actually present on the remote.
        setSelected({ organizations: p.organizations != null, users: p.users != null, roles: p.roles != null })
      })
      .catch((err) => { if (!cancelled) setError(toGitError(err).raw) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [branch])

  const available = (f: Family) => preview?.[f] != null
  const anySelected = FAMILIES.some((f) => available(f) && selected[f])
  const nothingRemote = preview != null && FAMILIES.every((f) => !available(f))

  const apply = async () => {
    if (!anySelected || applying) return
    setApplying(true); setError(null)
    try {
      const report = await settingsImportRemote({
        organizations: selected.organizations && available('organizations'),
        users: selected.users && available('users'),
        roles: selected.roles && available('roles'),
      }, branch)
      onApplied(report)
      onClose()
    } catch (err) {
      setError(toGitError(err).raw)
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[70vh] w-[92vw] max-w-[480px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ArrowDownToLine size={16} />
            {t('settings.pull_title')}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('settings.pull_loading')}
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-destructive">
            <AlertTriangle size={24} />
            {error}
          </div>
        ) : nothingRemote ? (
          <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
            {t('settings.pull_nothing')}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <p className="mb-3 text-xs text-muted-foreground">{t('settings.pull_intro')}</p>
            <div className="space-y-1">
              {FAMILIES.map((f) => {
                const count = preview?.[f]
                const disabled = count == null
                return (
                  <label
                    key={f}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
                  >
                    <Checkbox
                      checked={!disabled && selected[f]}
                      disabled={disabled}
                      onCheckedChange={() => setSelected((s) => ({ ...s, [f]: !s[f] }))}
                    />
                    <span className="flex-1 font-medium text-foreground">{t(`settings.versioning_include_${f}`)}</span>
                    <span className="text-muted-foreground">
                      {disabled ? t('settings.pull_family_absent') : t('settings.pull_family_count', { count })}
                    </span>
                  </label>
                )
              })}
            </div>
            <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400">{t('settings.versioning_no_passwords_notice')}</p>
          </div>
        )}

        {!loading && !error && !nothingRemote && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
            <Button variant="outline" size="sm" onClick={onClose} disabled={applying}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={apply} disabled={!anySelected || applying} className="gap-1.5">
              {applying ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
              {t('settings.pull_apply')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
