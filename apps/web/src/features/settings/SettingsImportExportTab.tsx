import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileUp, KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { isServerMode } from '@/lib/api-client'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { downloadBlob } from '@/lib/entity-io'
import { toGitError } from '@/lib/git-error-message'
import {
  downloadSettingsZip,
  settingsImportFile,
  type SettingsImportReport,
} from '@/lib/api/settings-versioning'
import { useOrganizationStore } from '@/stores/organization-store'

/**
 * Offline settings transfer: download the export ZIP (organizations + users +
 * roles, no passwords) and re-import a ZIP. The git-linked counterpart (push /
 * pull a repository) lives in the Versioning tab. Server-mode only.
 */
export function SettingsImportExportTab() {
  if (!isServerMode()) {
    return <div className="mt-6"><ServerModeNotice inline /></div>
  }
  return <Inner />
}

function Inner() {
  const { t } = useTranslation()
  const reloadOrgs = useOrganizationStore((s) => s.loadOrganizations)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [report, setReport] = useState<SettingsImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const doExport = async () => {
    setBusy('export'); setError(null)
    try {
      downloadBlob(await downloadSettingsZip(), 'settings.zip')
    } catch (err) {
      setError(toGitError(err).raw)
    } finally {
      setBusy(null)
    }
  }

  const doImport = async (file: File) => {
    setBusy('import'); setError(null); setReport(null)
    try {
      const rep = await settingsImportFile(file)
      setReport(rep)
      await reloadOrgs()
    } catch (err) {
      setError(toGitError(err).raw)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-5">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{t('settings.versioning_no_passwords_notice')}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('settings.ie_export_label')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.ie_export_intro')}</p>
        <Button size="sm" onClick={doExport} disabled={busy !== null} className="gap-1.5">
          {busy === 'export' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {t('settings.ie_export_button')}
        </Button>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-xs">{t('settings.ie_import_label')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.ie_import_intro')}</p>
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={busy !== null} className="gap-1.5">
          {busy === 'import' ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
          {t('settings.ie_import_button')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void doImport(f)
            e.target.value = ''
          }}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {report && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
          <p className="text-foreground">
            {t('settings.versioning_import_summary', {
              orgs: report.orgsCreated + report.orgsUpdated,
              users: report.usersCreated + report.usersUpdated,
              roles: report.rolesCreated + report.rolesUpdated,
            })}
          </p>
          {report.warnings.map((w, i) => (
            <p key={i} className="text-amber-700 dark:text-amber-400">{w}</p>
          ))}
        </div>
      )}
    </div>
  )
}
