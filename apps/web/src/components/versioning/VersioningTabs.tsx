import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, GitBranch, History, Info } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GitRepositoryTab } from './GitRepositoryTab'
import type { GitRemoteConfig } from '@/types'

export type VersioningTab = 'export' | 'git' | 'history'

interface VersioningTabsProps {
  /** Scope-specific export UI (project / workspace / entity export). */
  exportContent: ReactNode
  /** Current git link, or null when unlinked. */
  gitRemote: GitRemoteConfig | null
  /** Persist a git link (or null to unlink). */
  onSaveGitRemote: (config: GitRemoteConfig | null) => void | Promise<void>
  /** Local history is backend-only; disabled (stub) in client-only mode. Default false. */
  historyEnabled?: boolean
  /** Which tab to show first. */
  initialTab?: VersioningTab
  /** When true, fill the available height (page mode). When false, sized for a dialog. */
  fillHeight?: boolean
}

/**
 * Unified versioning UI — Export · Git repository · History — shared by the versioning
 * pages (project, workspace) and the per-entity dialog. Only the Export content differs
 * per scope; the Git and History tabs are identical everywhere.
 */
export function VersioningTabs({
  exportContent,
  gitRemote,
  onSaveGitRemote,
  historyEnabled = false,
  initialTab = 'export',
  fillHeight = false,
}: VersioningTabsProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<VersioningTab>(initialTab)

  // Export content may own its own scroll (e.g. WsExportTab's bounded card), so its tab is a
  // non-scrolling flex container. Git/History are short → plain (scroll only if needed).
  const exportContentClass = fillHeight ? 'min-h-0 flex-1 flex flex-col pt-3' : 'min-h-[280px] pt-3'
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
        <TabsTrigger value="history" className="flex-1 gap-1.5">
          <History size={14} />
          {t('versioning.tab_history')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="export" className={exportContentClass}>
        {exportContent}
      </TabsContent>

      <TabsContent value="git" className={sideContentClass}>
        <GitRepositoryTab gitRemote={gitRemote} onSave={onSaveGitRemote} />
      </TabsContent>

      <TabsContent value="history" className={sideContentClass}>
        {historyEnabled ? null : (
          <div className="flex flex-col items-center py-10">
            <History size={32} className="text-muted-foreground/50" />
            <p className="mt-3 text-sm font-medium text-foreground">{t('versioning.requires_backend')}</p>
            <div className="mt-3 flex max-w-md items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-amber-700 dark:text-amber-300">{t('versioning.requires_backend_description')}</p>
            </div>
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
