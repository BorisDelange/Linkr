import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { isServerMode } from '@/lib/api-client'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { toGitError } from '@/lib/git-error-message'
import type { GitErrorCode } from '@/lib/api/git'
import type { GitRemoteConfig } from '@/types'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import {
  getSettingsGitConfig,
  setSettingsGitConfig,
  settingsImportFile,
  settingsImportRemote,
  type SettingsImportReport,
} from '@/lib/api/settings-versioning'
import { useOrganizationStore } from '@/stores/organization-store'

/**
 * Account-level versioning: push organizations + users + roles to a git repo and
 * re-import them on a fresh instance. Passwords are never exported; an imported
 * user with no password lands disabled.
 *
 * The push side is the SAME UI as every other scope — GitRepositoryTab (repo +
 * token) wrapping GitSyncPanel (Quick actions / Details, per-file diff). Only two
 * things are settings-specific and live here: the git remote is a per-instance
 * singleton (not an entity's gitRemoteConfig), and Import (upsert from remote or
 * an uploaded ZIP). Server-mode only.
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

  const [gitRemote, setGitRemote] = useState<GitRemoteConfig | null>(null)
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState<SettingsImportReport | null>(null)
  const [error, setError] = useState<{ code: GitErrorCode; raw: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

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

  const afterImport = async (rep: SettingsImportReport) => {
    setReport(rep)
    // Import writes orgs/users/roles straight through the API — reload the org
    // store so Settings > Organizations reflects the new rows without a reload.
    await reloadOrgs()
  }

  const runImport = async (fn: () => Promise<SettingsImportReport>) => {
    setImporting(true)
    setError(null)
    setReport(null)
    try {
      await afterImport(await fn())
    } catch (err) {
      setError(toGitError(err))
    } finally {
      setImporting(false)
    }
  }

  const authBlocked = error?.code === 'auth_failed' || error?.code === 'auth_required'

  return (
    <div className="mt-6 flex flex-col gap-5">
      {/* Passwords notice — brief, above the repo UI. */}
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{t('settings.versioning_no_passwords_notice')}</p>
      </div>

      {/* Push side — identical to workspace/project versioning. */}
      <GitRepositoryTab gitRemote={gitRemote} onSave={saveGitRemote} syncScope="settings" syncId="account" />

      {/* Import side — settings-specific (pull-from-remote or upload a ZIP). */}
      {gitRemote && (
        <>
          <Separator />
          <div className="space-y-3">
            <Label className="text-xs">{t('settings.versioning_import_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.versioning_import_intro')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={importing} className="gap-1.5 text-xs"
                onClick={() => runImport(() => settingsImportRemote(gitRemote.branch))}>
                {importing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {t('settings.versioning_import_from_remote')}
              </Button>
              <Button size="sm" variant="outline" disabled={importing} className="gap-1.5 text-xs"
                onClick={() => fileInput.current?.click()}>
                <FileUp size={14} />
                {t('settings.versioning_import_from_file')}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void runImport(() => settingsImportFile(f))
                  e.target.value = ''
                }}
              />
            </div>

            {error && (
              <p className="text-xs text-destructive">{authBlocked ? t('versioning.sync_auth_blocked_body') : error.raw}</p>
            )}

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
    </div>
  )
}
