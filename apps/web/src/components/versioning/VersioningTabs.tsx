import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, GitBranch } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GitRepositoryTab } from './GitRepositoryTab'
import type { GitRemoteConfig } from '@/types'

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
  /** When true, fill the available height (page mode). When false, sized for a dialog. */
  fillHeight?: boolean
}

/**
 * Unified versioning UI — Export · Git repository — shared by the versioning
 * pages (project, workspace) and the per-entity dialog. Only the Export content
 * differs per scope; the Git tab is identical everywhere.
 */
export function VersioningTabs({
  exportContent,
  gitRemote,
  onSaveGitRemote,
  initialTab = 'export',
  fillHeight = false,
}: VersioningTabsProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<VersioningTab>(initialTab)

  // Export content may own its own scroll (e.g. WsExportTab's bounded card), so its tab is a
  // non-scrolling flex container. Git is short → plain (scroll only if needed).
  const exportContentClass = fillHeight ? 'min-h-0 flex-1 flex flex-col pt-3' : 'flex min-h-[280px] flex-col pt-3'
  const sideContentClass = fillHeight ? 'min-h-0 flex-1 overflow-auto pt-3' : 'min-h-[280px] pt-3'

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as VersioningTab)} className={fillHeight ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      <TabsList className="w-full">
        <TabsTrigger value="export" className="flex-1 gap-1.5">
          <Download size={14} />
          {t('versioning.tab_export')}
        </TabsTrigger>
        <TabsTrigger value="git" className="flex-1 gap-1.5">
          <GitBranch size={14} />
          {t('app_versioning.tab_git_repository')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="export" className={exportContentClass}>
        {exportContent}
      </TabsContent>

      <TabsContent value="git" className={sideContentClass}>
        <GitRepositoryTab gitRemote={gitRemote} onSave={onSaveGitRemote} />
      </TabsContent>
    </Tabs>
  )
}
