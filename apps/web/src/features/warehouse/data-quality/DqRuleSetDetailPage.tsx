import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowLeft, Code, BarChart3, History, Database } from 'lucide-react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useDqStore } from '@/stores/dq-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { DqChecksTab } from './DqChecksTab'
import { DqResultsView } from './DqResultsView'
import { DqRunHistoryTab } from './DqRunHistoryTab'
import type { DqReport } from '@/lib/duckdb/data-quality'

type TabId = 'checks' | 'results' | 'history'

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'checks', labelKey: 'data_quality.tab_checks', icon: Code },
  { id: 'results', labelKey: 'data_quality.tab_results', icon: BarChart3 },
  { id: 'history', labelKey: 'data_quality.tab_history', icon: History },
]

interface Props {
  ruleSetId: string
}

export function DqRuleSetDetailPage({ ruleSetId }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const {
    dqRuleSets,
    dqRuleSetsLoaded,
    loadDqRuleSets,
    loadRuleSetChecks,
    updateRuleSet,
    customChecks,
    runHistory,
    addRunHistory,
  } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const [activeTab, setActiveTab] = useState<TabId>('checks')

  useEffect(() => {
    if (!dqRuleSetsLoaded) loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])

  // ruleSetId may be a short prefix from the URL; resolve to the full id before any store call.
  const ruleSet = resolveByIdPrefix(dqRuleSets, ruleSetId, (rs) => rs.id)
  const fullRuleSetId = ruleSet?.id

  useEffect(() => {
    if (fullRuleSetId) loadRuleSetChecks(fullRuleSetId)
  }, [fullRuleSetId, loadRuleSetChecks])
  const activeSource = dataSources.find((ds) => ds.id === ruleSet?.dataSourceId)

  const handleBack = useCallback(() => {
    // Navigate to the data-quality list page using absolute path
    if (wsUid) {
      navigate(paths.warehouseDataQuality(wsUid))
    } else {
      navigate('..')
    }
  }, [wsUid, navigate])

  const handleScanComplete = useCallback((report: DqReport) => {
    if (!ruleSet) return

    const applicable = report.summary.total - report.summary.notApplicable
    const score = applicable > 0 ? Math.round((report.summary.passed / applicable) * 100) : 100
    const durationMs = report.results.reduce((sum, r) => sum + r.executionTimeMs, 0)

    updateRuleSet(ruleSet.id, {
      status: report.summary.failed > 0 ? 'error' : 'success',
      lastRunAt: report.computedAt,
      lastRunDurationMs: durationMs,
      lastScore: score,
    })

    addRunHistory({
      id: `run_${Date.now()}`,
      ruleSetId: ruleSet.id,
      dataSourceId: ruleSet.dataSourceId,
      startedAt: report.computedAt,
      completedAt: new Date().toISOString(),
      status: 'success',
      score,
      totalChecks: report.summary.total,
      passed: report.summary.passed,
      failed: report.summary.failed,
      errors: report.summary.errors,
      notApplicable: report.summary.notApplicable,
      durationMs,
    })
  }, [ruleSet, updateRuleSet, addRunHistory])

  if (!dqRuleSetsLoaded) return null

  if (!ruleSet) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('data_quality.rs_not_found')}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={handleBack}>
          <ArrowLeft size={14} />
          {t('data_quality.back_to_list')}
        </Button>
      </div>
    )
  }

  const ruleSetHistory = runHistory.filter((e) => e.ruleSetId === ruleSet.id)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <div className="flex items-center gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors',
                activeTab === tab.id
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <tab.icon size={14} />
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Select
            value={ruleSet.dataSourceId}
            onValueChange={(value) => updateRuleSet(ruleSet.id, { dataSourceId: value })}
          >
            <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
              <Database size={12} className="text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dbSources.map((ds) => (
                <SelectItem key={ds.id} value={ds.id}>
                  {ds.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Tab content. Checks + Results stay MOUNTED (hidden when inactive) so their
          in-tab state — scan report, filters, selection, search — survives switching
          tabs. History is light + read-only, so it's fine to mount on demand. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn('h-full', activeTab !== 'checks' && 'hidden')}>
          <DqChecksTab ruleSetId={ruleSet.id} dataSourceId={ruleSet.dataSourceId} />
        </div>
        <div className={cn('h-full', activeTab !== 'results' && 'hidden')}>
          <DqResultsView
            dataSourceId={ruleSet.dataSourceId}
            schemaMapping={activeSource?.schemaMapping}
            customChecks={customChecks}
            onScanComplete={handleScanComplete}
          />
        </div>
        {activeTab === 'history' && (
          <DqRunHistoryTab entries={ruleSetHistory} />
        )}
      </div>
    </div>
  )
}
