import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import { VersioningTabs } from '@/components/versioning/VersioningTabs'
import { WsExportTab } from './WsExportTab'

export function AppVersioningPage() {
  const { t } = useTranslation()
  const { wsUid } = useResolvedParams()
  const { remoteConfig, loadRemoteConfig, setRemoteConfig, clearRemoteConfig } = useWorkspaceVersioningStore()

  useEffect(() => {
    if (wsUid) void loadRemoteConfig(wsUid)
  }, [wsUid, loadRemoteConfig])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-2 text-center">
        <h1 className="text-2xl font-bold text-foreground">{t('app_versioning.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('app_versioning.description')}</p>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-6 pb-6">
        <VersioningTabs
          fillHeight
          gitRemote={remoteConfig}
          onSaveGitRemote={(cfg) => (wsUid ? (cfg ? setRemoteConfig(wsUid, cfg) : clearRemoteConfig(wsUid)) : Promise.resolve())}
          exportContent={<WsExportTab />}
        />
      </div>
    </div>
  )
}
