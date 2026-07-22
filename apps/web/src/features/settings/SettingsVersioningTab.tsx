import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import type { GitRemoteConfig } from '@/types'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import {
  getSettingsGitConfig,
  setSettingsGitConfig,
} from '@/lib/api/settings-versioning'
import { useOrganizationStore } from '@/stores/organization-store'
import { SettingsPullDialog } from './SettingsPullDialog'

/**
 * Git versioning for account-level config, identical to workspace/project
 * versioning: GitRepositoryTab (repo + token) wrapping GitSyncPanel (Quick actions
 * / Details, per-file diff + push). When the remote has moved ahead, the panel's
 * "behind" banner opens the settings pull dialog (choose organizations / users /
 * roles). Offline ZIP import/export lives in the Import and Export tabs.
 */
export function SettingsVersioningTab() {
  return <SettingsVersioningInner />
}

function SettingsVersioningInner() {
  const { t } = useTranslation()
  const reloadOrgs = useOrganizationStore((s) => s.loadOrganizations)
  const [gitRemote, setGitRemote] = useState<GitRemoteConfig | null>(null)

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

  return (
    <div className="mt-6 flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{t('settings.versioning_no_passwords_notice')}</p>
      </div>

      <GitRepositoryTab
        gitRemote={gitRemote}
        onSave={saveGitRemote}
        syncScope="settings"
        syncId="account"
        // The "behind" banner opens the settings pull dialog (upsert, per-family
        // choice) instead of the mapping-project 3-way merge. onPulled (from the
        // panel) already refreshes status + sync anchor; also reload the org store.
        renderPullDialog={({ branch, onClose, onPulled }) => (
          <SettingsPullDialog
            branch={branch}
            onClose={onClose}
            onApplied={async () => { await reloadOrgs(); await onPulled() }}
          />
        )}
      />
    </div>
  )
}
