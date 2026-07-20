import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { isServerMode } from '@/lib/api-client'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import type { GitRemoteConfig } from '@/types'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import { useGitSyncStore } from '@/stores/git-sync-store'
import {
  getSettingsGitConfig,
  setSettingsGitConfig,
  type SettingsImportReport,
} from '@/lib/api/settings-versioning'
import { useOrganizationStore } from '@/stores/organization-store'
import { SettingsPullDialog } from './SettingsPullDialog'

/**
 * Git versioning for account-level config. Push is the SAME UI as every other scope
 * — GitRepositoryTab (repo + token) wrapping GitSyncPanel (Quick actions / Details,
 * per-file diff). Pull is a dedicated dialog that mirrors the mapping-project pull
 * (choose which of organizations / users / roles to apply). Offline ZIP transfer
 * lives in the separate Import / Export tab. Server-mode only.
 */
export function SettingsVersioningTab() {
  if (!isServerMode()) {
    return <div className="mt-6"><ServerModeNotice inline /></div>
  }
  return <SettingsVersioningInner />
}

function SettingsVersioningInner() {
  const { t } = useTranslation()
  const reloadOrgs = useOrganizationStore((s) => s.loadOrganizations)
  const refreshStatus = useGitSyncStore((s) => s.refreshStatus)

  const [gitRemote, setGitRemote] = useState<GitRemoteConfig | null>(null)
  const [pullOpen, setPullOpen] = useState(false)
  const [report, setReport] = useState<SettingsImportReport | null>(null)

  useEffect(() => {
    let cancelled = false
    void getSettingsGitConfig().then((cfg) => {
      if (!cancelled && cfg.url) setGitRemote({ url: cfg.url, branch: cfg.branch ?? 'main' })
    })
    return () => { cancelled = true }
  }, [])

  // GitRepositoryTab already stored the token per (user, host) on connect; here we
  // only persist the settings remote (url + branch), or clear it on disconnect.
  const saveGitRemote = useCallback(async (config: GitRemoteConfig | null) => {
    const saved = await setSettingsGitConfig(config?.url ?? null, config?.branch ?? null)
    setGitRemote(saved.url ? { url: saved.url, branch: saved.branch ?? 'main' } : null)
  }, [])

  const onPulled = async (rep: SettingsImportReport) => {
    setReport(rep)
    // Import wrote orgs/users/roles straight through the API → reload the org store
    // so Settings > Organizations reflects the new rows without a full reload...
    await reloadOrgs()
    // ...and re-run the push panel's status so its file list reflects the new local
    // state vs the remote (the pulled files typically drop off "to push").
    if (gitRemote) void refreshStatus('settings', 'account', gitRemote.branch)
  }

  return (
    <div className="mt-6 flex flex-col gap-5">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{t('settings.versioning_no_passwords_notice')}</p>
      </div>

      {/* Push side — identical to workspace/project versioning. */}
      <GitRepositoryTab gitRemote={gitRemote} onSave={saveGitRemote} syncScope="settings" syncId="account" />

      {/* Pull side — a dedicated dialog with a per-family choice. */}
      {gitRemote && (
        <>
          <Separator />
          <div className="space-y-2">
            <Label className="text-xs">{t('settings.pull_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.pull_desc')}</p>
            <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => setPullOpen(true)}>
              <ArrowDownToLine size={14} />
              {t('settings.pull_button')}
            </Button>
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
        </>
      )}

      {pullOpen && gitRemote && (
        <SettingsPullDialog branch={gitRemote.branch} onClose={() => setPullOpen(false)} onApplied={onPulled} />
      )}
    </div>
  )
}
