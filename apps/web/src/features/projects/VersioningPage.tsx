import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useSearchParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useVersioningStore } from '@/stores/versioning-store'
import { VersioningTabs } from '@/components/versioning/VersioningTabs'
import { useRememberedVersioningTab } from '@/components/versioning/use-remembered-versioning-tab'
import { ProjectPull } from '@/components/versioning/ProjectPull'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useCohortStore } from '@/stores/cohort-store'
import { ExportTab } from './versioning/ExportTab'

export function VersioningPage() {
  const { t } = useTranslation()
  const projectUid = useAppStore((s) => s.activeProjectUid)
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const tabParam = searchParams.get('tab')
  const forcedTab = tabParam === 'git' || tabParam === 'export' ? tabParam : null
  const { initialTab, onTabChange } = useRememberedVersioningTab('projects', forcedTab)
  // Drive the active tab as controlled state so a menu that changes ?tab= while
  // we're already on this page switches the tab (a remount isn't triggered, so
  // initialTab alone wouldn't re-apply). We adjust state during render (keyed on
  // location.key so re-clicking the same menu item re-forces) rather than in an
  // effect, per React's "adjusting state on prop change" guidance — no extra pass.
  const [tab, setTab] = useState(initialTab)
  const [lastNav, setLastNav] = useState(location.key)
  if (location.key !== lastNav) {
    setLastNav(location.key)
    if (forcedTab) setTab(forcedTab)
  }
  const remoteConfig = useVersioningStore((s) => s.remoteConfig)
  const remoteConfigUid = useVersioningStore((s) => s.projectUid)
  const loadRemoteConfig = useVersioningStore((s) => s.loadRemoteConfig)
  const setRemoteConfig = useVersioningStore((s) => s.setRemoteConfig)
  const clearRemoteConfig = useVersioningStore((s) => s.clearRemoteConfig)
  // The store is a singleton shared by every project: showing its remote before the
  // load for THIS project lands would display another project's repository.
  const projectRemote = remoteConfigUid === projectUid ? remoteConfig : null

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
          gitRemote={projectRemote}
          onSaveGitRemote={(cfg) => {
            if (!projectUid) return
            if (cfg) setRemoteConfig(projectUid, cfg)
            else clearRemoteConfig(projectUid)
          }}
          exportContent={<ExportTab />}
          tab={tab}
          onTabChange={(v) => { setTab(v); onTabChange(v) }}
          syncScope="projects"
          syncId={projectUid ?? undefined}
          renderInlinePull={projectUid ? ({ branch, remoteHead, mode, onPulled }) => (
            <ProjectPull
              projectUid={projectUid}
              branch={branch}
              remoteHead={remoteHead}
              mode={mode}
              onPulled={onPulled}
            />
          ) : undefined}
          onAfterPull={async () => {
            // The pull wrote to storage; the project views read from in-memory
            // stores — invalidate them so the pulled dashboards/datasets/scripts/
            // cohorts/pipelines show without a manual refresh (mirrors import).
            useDashboardStore.setState({ activeProjectUid: null, loaded: false })
            useDatasetStore.setState({ activeProjectUid: null })
            useFileStore.setState({ activeProjectUid: null })
            await usePipelineStore.getState().loadPipelines()
            await useCohortStore.getState().loadCohorts()
          }}
        />
      </div>
    </div>
  )
}
