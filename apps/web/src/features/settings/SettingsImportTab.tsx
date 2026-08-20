import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { isServerMode } from '@/lib/api-client'
import { ImportSourceDialog, type ImportGitRemote } from '@/components/ui/import-source-dialog'
import { gitSetSyncState } from '@/lib/api/git'
import { toGitError } from '@/lib/git-error-message'
import {
  getSettingsGitConfig,
  setSettingsGitConfig,
  settingsImportFile,
  type SettingsImportReport,
} from '@/lib/api/settings-versioning'
import { useOrganizationStore } from '@/stores/organization-store'

/**
 * Import settings (organizations / users / roles) from a ZIP or by cloning a git
 * repository — the account-level counterpart of a project/workspace Import. A git
 * clone imports the tree AND links the repo (url + token), exactly like importing
 * a project from git. Once a repo is linked, the git option drops out: re-syncing
 * is then the Versioning tab's pull. New users land disabled (no password).
 * Server-mode only.
 */
export function SettingsImportTab() {
  const { t } = useTranslation()
  const reloadOrgs = useOrganizationStore((s) => s.loadOrganizations)
  const [linked, setLinked] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [report, setReport] = useState<SettingsImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isServerMode()) return
    let cancelled = false
    void getSettingsGitConfig().then((cfg) => { if (!cancelled) setLinked(!!cfg.url) })
    return () => { cancelled = true }
  }, [])


  const handleImport = async (file: File, gitRemote?: ImportGitRemote) => {
    setError(null); setReport(null)
    try {
      const rep = await settingsImportFile(file)
      // Cloned from git → link the repo (url + branch + token) and anchor the sync
      // state to the cloned HEAD, so the Versioning tab is pre-linked and a later
      // push/pull diffs correctly — same as importing a project from git.
      if (gitRemote) {
        await setSettingsGitConfig(gitRemote.url, gitRemote.branch, gitRemote.authToken)
        if (gitRemote.syncedOid) {
          await gitSetSyncState('settings', 'account', gitRemote.branch, gitRemote.syncedOid)
        }
        setLinked(true)
      }
      setReport(rep)
      // Import wrote orgs/users/roles straight through the API — reload the org store.
      await reloadOrgs()
      setDialogOpen(false)
    } catch (err) {
      setError(toGitError(err).raw)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{t('settings.versioning_no_passwords_notice')}</p>
      </div>

      <div className="space-y-2">
        <Label>{t('settings.import_label')}</Label>
        <p className="text-xs text-muted-foreground">
          {linked ? t('settings.import_intro_linked') : t('settings.import_intro')}
        </p>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)} className="gap-1.5 text-xs">
          <Upload size={14} />
          {t('settings.import_button')}
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

      {/* Once a repo is linked, only ZIP import is offered — the git path is the pull. */}
      <ImportSourceDialog open={dialogOpen} onOpenChange={setDialogOpen} onImport={handleImport} hideGit={linked} />
    </div>
  )
}
