import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, GitBranch } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GitRepositoryTab } from './GitRepositoryTab'
import type { GitRemoteConfig } from '@/types'
import type { GitScope } from '@/lib/api/git'
import type { GitSyncPanel } from './GitSyncPanel'

export type VersioningTab = 'export' | 'git'

interface VersioningTabsProps {
  /** Scope-specific export UI (project / workspace / entity export). */
  exportContent: ReactNode
  /** Current git link, or null when unlinked. */
  gitRemote: GitRemoteConfig | null
  /** Persist a git link (or null to unlink). */
  onSaveGitRemote: (config: GitRemoteConfig | null) => void | Promise<void>
  /** Which tab to show first. */
  initialTab?: VersioningTab
  /** Controlled active tab (with onTabChange). Lets a parent resize around it. */
  tab?: VersioningTab
  /** Notified when the active tab changes (controlled or uncontrolled). */
  onTabChange?: (tab: VersioningTab) => void
  /** When true, fill the available height (page mode). When false, sized for a dialog. */
  fillHeight?: boolean
  /** Scope + id enable the push-only sync panel in the Git tab (server mode). */
  syncScope?: GitScope
  syncId?: string
  /** Custom pull UI for scopes with their own pull flow (forwarded to the sync panel). */
  renderPullDialog?: React.ComponentProps<typeof GitSyncPanel>['renderPullDialog']
  /** Inline pull (forwarded to the sync panel) — preferred over renderPullDialog. */
  renderInlinePull?: React.ComponentProps<typeof GitSyncPanel>['renderInlinePull']
  /** Scope-specific store refresh after a pull (forwarded to the sync panel). */
  onAfterPull?: React.ComponentProps<typeof GitSyncPanel>['onAfterPull']
  /** Hide the Export tab and show only Git (e.g. entities whose export lives elsewhere). */
  gitOnly?: boolean
}

/**
 * Unified versioning UI — Git repository · Export — shared by the versioning
 * pages (project, workspace) and the per-entity dialog. Only the Export content
 * differs per scope; the Git tab is identical everywhere. Git comes first (and
 * is the default): syncing to a repo is the primary flow, ZIP export the fallback.
 */
export function VersioningTabs({
  exportContent,
  gitRemote,
  onSaveGitRemote,
  initialTab = 'git',
  tab: controlledTab,
  onTabChange,
  fillHeight = false,
  syncScope,
  syncId,
  renderPullDialog,
  renderInlinePull,
  onAfterPull,
  gitOnly = false,
}: VersioningTabsProps) {
  const { t } = useTranslation()
  const [uncontrolledTab, setUncontrolledTab] = useState<VersioningTab>(gitOnly ? 'git' : initialTab)
  const tab = controlledTab ?? uncontrolledTab
  const setTab = (v: VersioningTab) => {
    setUncontrolledTab(v)
    onTabChange?.(v)
  }

  // Export content may own its own scroll (e.g. WsExportTab's bounded card), so its tab is a
  // non-scrolling flex container. The Git tab, once linked, is a full-height flex column whose
  // sync panel owns its own scroll — so in page mode it must NOT scroll at the tab level.
  // px-1 (pb-1) gives the inner cards' shadow-sm room so it isn't clipped by overflow ancestors.
  const exportContentClass = fillHeight ? 'min-h-0 flex-1 flex flex-col pt-3 px-1' : 'flex flex-col pt-3 px-1'
  const sideContentClass = fillHeight ? 'min-h-0 flex-1 flex flex-col pt-3 px-1 pb-1' : 'pt-3 px-1'

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as VersioningTab)} className={fillHeight ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      <TabsList className="w-full">
        <TabsTrigger value="git" className="flex-1 gap-1.5">
          <GitBranch size={14} />
          {t('app_versioning.tab_git_repository')}
        </TabsTrigger>
        {!gitOnly && (
          <TabsTrigger value="export" className="flex-1 gap-1.5">
            <Download size={14} />
            {t('versioning.tab_export')}
          </TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="git" className={sideContentClass}>
        <GitRepositoryTab gitRemote={gitRemote} onSave={onSaveGitRemote} syncScope={syncScope} syncId={syncId} renderPullDialog={renderPullDialog} renderInlinePull={renderInlinePull} onAfterPull={onAfterPull} />
      </TabsContent>

      {!gitOnly && (
        <TabsContent value="export" className={exportContentClass}>
          {exportContent}
        </TabsContent>
      )}
    </Tabs>
  )
}
