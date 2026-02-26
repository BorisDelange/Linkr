import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ShieldCheck, Database } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useDqStore } from '@/stores/dq-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { ListPageTemplate } from '../ListPageTemplate'
import { CreateDqRuleSetDialog } from './CreateDqRuleSetDialog'
import type { DqRuleSet, DqRuleSetStatus } from '@/types'

const STATUS_BADGE: Record<DqRuleSetStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  draft: { variant: 'secondary', label: 'data_quality.rs_status_draft' },
  ready: { variant: 'outline', label: 'data_quality.rs_status_ready' },
  running: { variant: 'default', label: 'data_quality.rs_status_running' },
  success: { variant: 'default', label: 'data_quality.rs_status_success' },
  error: { variant: 'destructive', label: 'data_quality.rs_status_error' },
}

function scoreColor(score?: number) {
  if (score == null) return ''
  if (score >= 95) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 80) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

export function DqRuleSetListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { dqRuleSetsLoaded, loadDqRuleSets, getWorkspaceRuleSets, deleteRuleSet } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    if (!dqRuleSetsLoaded) loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])

  const ruleSets = activeWorkspaceId ? getWorkspaceRuleSets(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? '—'

  return (
    <ListPageTemplate<DqRuleSet>
      titleKey="data_quality.rs_title"
      descriptionKey="data_quality.rs_description"
      newButtonKey="data_quality.new_rule_set"
      emptyTitleKey="data_quality.no_rule_sets"
      emptyDescriptionKey="data_quality.no_rule_sets_description"
      deleteConfirmTitleKey="data_quality.delete_rs_title"
      deleteConfirmDescriptionKey="data_quality.delete_rs_description"
      emptyIcon={ShieldCheck}
      items={ruleSets}
      onNavigate={(id) => navigate(id)}
      onDelete={(id) => deleteRuleSet(id)}
      renderCardBody={(rs) => {
        const statusInfo = STATUS_BADGE[rs.status]
        return (
          <>
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
              <ShieldCheck size={20} className="text-teal-500" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{rs.name}</span>
                <Badge variant={statusInfo.variant} className="text-[10px]">
                  {t(statusInfo.label)}
                </Badge>
                {rs.lastScore != null && (
                  <span className={cn('text-xs font-mono font-medium', scoreColor(rs.lastScore))}>
                    {rs.lastScore}%
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Database size={12} />
                <span>{getSourceName(rs.dataSourceId)}</span>
              </div>
              {rs.lastRunAt && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t('data_quality.last_run')}: {new Date(rs.lastRunAt).toLocaleString()}
                  {rs.lastRunDurationMs != null && ` (${(rs.lastRunDurationMs / 1000).toFixed(1)}s)`}
                </p>
              )}
            </div>
          </>
        )
      }}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateDqRuleSetDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={({ item, onOpenChange }) => (
        <CreateDqRuleSetDialog open onOpenChange={onOpenChange} editingRuleSet={item} />
      )}
    />
  )
}
