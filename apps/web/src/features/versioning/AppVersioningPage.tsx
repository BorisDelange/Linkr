import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useSearchParams } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import { VersioningTabs } from '@/components/versioning/VersioningTabs'
import { useRememberedVersioningTab } from '@/components/versioning/use-remembered-versioning-tab'
import { useWikiStore } from '@/stores/wiki-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { reinstallWorkspaceFromGit } from '@/lib/workspace-reinstall'
import type { GitRemoteConfig } from '@/types'
import { WsExportTab } from './WsExportTab'

export function AppVersioningPage() {
  const { t, i18n } = useTranslation()
  const { wsUid } = useResolvedParams()
  // Rebuilding deletes whatever the repository does not carry: the workspace
  // delete's permission, not the settings one.
  const canDelete = useMyWorkspaceRole(wsUid).can('workspace-settings:delete')
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const tabParam = searchParams.get('tab')
  const forcedTab = tabParam === 'git' || tabParam === 'export' ? tabParam : null
  const { initialTab, onTabChange } = useRememberedVersioningTab('workspaces', forcedTab)
  const remoteConfig = useWorkspaceVersioningStore((s) => s.remoteConfig)
  const remoteConfigWsId = useWorkspaceVersioningStore((s) => s.workspaceId)
  const loadRemoteConfig = useWorkspaceVersioningStore((s) => s.loadRemoteConfig)
  const setRemoteConfig = useWorkspaceVersioningStore((s) => s.setRemoteConfig)
  const clearRemoteConfig = useWorkspaceVersioningStore((s) => s.clearRemoteConfig)
  // The store is a singleton shared by every workspace: showing its remote before
  // the load for THIS workspace lands would display another workspace's repository.
  const wsRemote = remoteConfigWsId === wsUid ? remoteConfig : null
  // Controlled tab so a menu changing ?tab= while already on this page switches
  // the tab (see VersioningPage for the rationale — adjust during render, keyed
  // on location.key so re-clicking the same menu item re-forces).
  const [tab, setTab] = useState(initialTab)
  const [lastNav, setLastNav] = useState(location.key)
  if (location.key !== lastNav) {
    setLastNav(location.key)
    if (forcedTab) setTab(forcedTab)
  }

  useEffect(() => {
    if (wsUid) void loadRemoteConfig(wsUid)
  }, [wsUid, loadRemoteConfig])

  const reloadWiki = async () => {
    if (wsUid && useWikiStore.getState().currentWorkspaceId === wsUid) await useWikiStore.getState().loadPages(wsUid)
  }

  const handleReinstall = wsUid && canDelete
    ? async (config: GitRemoteConfig) => {
      const failure = await reinstallWorkspaceFromGit(wsUid, config, i18n.language)
      await reloadWiki()
      return failure
    }
    : undefined

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-2 text-center">
        <h1 className="text-2xl font-bold text-foreground">{t('app_versioning.title')}</h1>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-6 pb-6">
        <VersioningTabs
          fillHeight
          gitRemote={wsRemote}
          onSaveGitRemote={(cfg) => (wsUid ? (cfg ? setRemoteConfig(wsUid, cfg) : clearRemoteConfig(wsUid)) : Promise.resolve())}
          exportContent={<WsExportTab />}
          tab={tab}
          onTabChange={(v) => { setTab(v); onTabChange(v) }}
          syncScope="workspaces"
          syncId={wsUid ?? undefined}
          onAfterPull={reloadWiki}
          onReinstall={handleReinstall}
        />
      </div>
    </div>
  )
}
