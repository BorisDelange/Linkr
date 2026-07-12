import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useVersioningStore } from '@/stores/versioning-store'
import { VersioningTabs } from '@/components/versioning/VersioningTabs'
import { ExportTab } from './versioning/ExportTab'

export function VersioningPage() {
  const { t } = useTranslation()
  const projectUid = useAppStore((s) => s.activeProjectUid)
  const [searchParams] = useSearchParams()
  const initialTab = searchParams.get('tab') === 'git' ? 'git' : 'export'
  const { remoteConfig, loadRemoteConfig, setRemoteConfig, clearRemoteConfig } = useVersioningStore()

  useEffect(() => {
    if (projectUid) void loadRemoteConfig(projectUid)
  }, [projectUid, loadRemoteConfig])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2 text-center">
        <h1 className="text-2xl font-bold text-foreground">{t('versioning.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('versioning.description')}</p>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-6 pb-6">
        <VersioningTabs
          fillHeight
          gitRemote={remoteConfig}
          onSaveGitRemote={(cfg) => (cfg ? setRemoteConfig(cfg) : clearRemoteConfig())}
          exportContent={<ExportTab />}
          initialTab={initialTab}
          syncScope="projects"
          syncId={projectUid ?? undefined}
        />
      </div>
    </div>
  )
}
