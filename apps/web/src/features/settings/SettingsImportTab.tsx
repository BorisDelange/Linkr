import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, GitBranch, KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { isServerMode } from '@/lib/api-client'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { toGitError } from '@/lib/git-error-message'
import {
  getSettingsGitConfig,
  settingsImportFile,
  type SettingsImportReport,
} from '@/lib/api/settings-versioning'
import { useOrganizationStore } from '@/stores/organization-store'
import { SettingsPullDialog } from './SettingsPullDialog'

/**
 * Import settings (organizations / users / roles) from a ZIP or from the linked
 * git repository — the account-level counterpart of a project's Import tab. New
 * users land disabled (no password). Server-mode only.
 */
export function SettingsImportTab() {
  const { t } = useTranslation()
  const reloadOrgs = useOrganizationStore((s) => s.loadOrganizations)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [gitLinked, setGitLinked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<SettingsImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pullOpen, setPullOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isServerMode()) return
    let cancelled = false
    void getSettingsGitConfig().then((cfg) => {
      if (cancelled) return
      setGitLinked(!!cfg.url)
      setGitBranch(cfg.branch ?? 'main')
    })
    return () => { cancelled = true }
  }, [])

  if (!isServerMode()) {
    return <div className="mt-6"><ServerModeNotice inline /></div>
  }

  const afterImport = async (rep: SettingsImportReport) => {
    setReport(rep)
    // Import writes orgs/users/roles straight through the API — reload the org store
    // so Settings > Organizations reflects the new rows without a full reload.
    await reloadOrgs()
  }

  const importFile = async (file: File) => {
    setBusy(true); setError(null); setReport(null)
    try {
      await afterImport(await settingsImportFile(file))
    } catch (err) {
      setError(toGitError(err).raw)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-5">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{t('settings.versioning_no_passwords_notice')}</p>
      </div>

      {/* From a ZIP file */}
      <div className="space-y-2">
        <Label className="text-xs">{t('settings.import_from_zip_label')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.import_from_zip_intro')}</p>
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={busy} className="gap-1.5 text-xs">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
          {t('settings.import_from_zip_button')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importFile(f)
            e.target.value = ''
          }}
        />
      </div>

      <Separator />

      {/* From the linked git repository */}
      <div className="space-y-2">
        <Label className="text-xs">{t('settings.import_from_git_label')}</Label>
        <p className="text-xs text-muted-foreground">
          {gitLinked ? t('settings.import_from_git_intro') : t('settings.import_from_git_unlinked')}
        </p>
        <Button size="sm" variant="outline" onClick={() => setPullOpen(true)} disabled={!gitLinked || busy} className="gap-1.5 text-xs">
          <GitBranch size={14} />
          {t('settings.import_from_git_button')}
        </Button>
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

      {pullOpen && (
        <SettingsPullDialog
          branch={gitBranch ?? undefined}
          onClose={() => setPullOpen(false)}
          onApplied={(rep) => void afterImport(rep)}
        />
      )}
    </div>
  )
}
