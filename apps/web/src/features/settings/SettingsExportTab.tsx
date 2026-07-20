import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { isServerMode } from '@/lib/api-client'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { downloadBlob } from '@/lib/entity-io'
import { toGitError } from '@/lib/git-error-message'
import { downloadSettingsZip } from '@/lib/api/settings-versioning'

/** Download the settings export as a ZIP (organizations + users + roles, no
 *  passwords). Server-mode only. */
export function SettingsExportTab() {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isServerMode()) {
    return <div className="mt-6"><ServerModeNotice inline /></div>
  }

  const doExport = async () => {
    setBusy(true); setError(null)
    try {
      downloadBlob(await downloadSettingsZip(), 'settings.zip')
    } catch (err) {
      setError(toGitError(err).raw)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{t('settings.versioning_no_passwords_notice')}</p>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t('settings.ie_export_label')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.ie_export_intro')}</p>
        <Button size="sm" onClick={doExport} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {t('settings.ie_export_button')}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
