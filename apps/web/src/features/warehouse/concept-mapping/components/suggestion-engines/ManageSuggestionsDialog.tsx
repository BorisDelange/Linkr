import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { isServerMode } from '@/lib/api-client'
import { getSuggestionEngines, type SuggestionEngines } from '@/lib/api/suggestion-engines'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { SuggestionComputeTab } from './SuggestionComputeTab'

type Tab = 'methods' | 'compute'

const STACKED = 'col-start-1 row-start-1 flex flex-col data-[state=inactive]:invisible'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  workspaceId: string
  /** The Methods tab: weights, the methods of the scores file, import / delete. */
  methodsPanel: ReactNode
  /** A computation ended: reload the project's scores index. */
  onComputed: () => void
}

/**
 * Manage suggestions: how the scores file is weighed and versioned (Methods),
 * and computing it from the app (Compute) — whose semantic section opens the
 * workspace's embedding models and configurations.
 */
export function ManageSuggestionsDialog({ open, onOpenChange, projectId, workspaceId, methodsPanel, onComputed }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('methods')
  const [engines, setEngines] = useState<SuggestionEngines | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { can } = useMyWorkspaceRole(workspaceId)
  const server = isServerMode()

  const reload = useCallback(() => {
    getSuggestionEngines(workspaceId)
      .then((e) => { setEngines(e); setLoadError(null) })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [workspaceId])

  useEffect(() => {
    if (open && server) reload()
  }, [open, server, reload])

  const serverOnly = (body: (engines: SuggestionEngines) => ReactNode) => {
    if (!server) return <div className="p-4"><ServerModeNotice inline description={t('concept_mapping.engines_server_only')} /></div>
    if (loadError) return <p className="p-4 text-xs text-destructive">{loadError}</p>
    if (!engines) return <div className="p-4"><Loader2 size={14} className="animate-spin text-muted-foreground" /></div>
    return body(engines)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      className="h-auto sm:max-w-2xl"
      title={t('concept_mapping.suggestions_manage')}
      description={t('concept_mapping.suggestions_manage_subtitle')}
      hideFooter
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex h-full min-h-0 flex-col">
        <TabsList className="w-full">
          <TabsTrigger value="methods" className="flex-1">{t('concept_mapping.engines_methods_tab')}</TabsTrigger>
          <TabsTrigger value="compute" className="flex-1">{t('concept_mapping.engines_compute_tab')}</TabsTrigger>
        </TabsList>
        {/* Both tabs stay mounted in one grid cell, the hidden one invisible: the
            dialog takes the taller one's height and keeps it across a switch. */}
        <div className="grid min-h-0 flex-1 overflow-auto">
        <TabsContent value="methods" forceMount className={STACKED}>{methodsPanel}</TabsContent>
        <TabsContent value="compute" forceMount className={STACKED}>
          {serverOnly((e) => (
            <SuggestionComputeTab
              projectId={projectId}
              workspaceId={workspaceId}
              engines={e}
              canWrite={can('concept-mapping:write')}
              canManageEngines={can('workspace-settings:write')}
              onComputed={onComputed}
              reloadEngines={reload}
            />
          ))}
        </TabsContent>
        </div>
      </Tabs>
    </DialogShell>
  )
}
