import { useTranslation } from 'react-i18next'
import { Users, BarChart3, Table2, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResultsTable } from './ResultsTable'
import { AttritionChart } from './AttritionChart'
import type { CohortExecutionResult } from '@/types'
import { useState } from 'react'

interface ResultsPanelProps {
  result: CohortExecutionResult | null
  loading: boolean
  onExecute: () => void
  onExportCsv: () => void
}

export function ResultsPanel({ result, loading, onExecute, onExportCsv }: ResultsPanelProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'results' | 'attrition'>('results')

  if (!result && !loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Users size={32} className="opacity-30" />
        <p className="text-sm">{t('cohorts.results_empty')}</p>
        <Button variant="outline" size="sm" onClick={onExecute} className="gap-1.5">
          {t('cohorts.execute')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Count header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            {t('cohorts.executing')}
          </div>
        ) : result ? (
          <>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
                <Users size={16} className="text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-lg font-bold leading-none">{result.totalCount.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground">{t('cohorts.results_count')}</p>
              </div>
            </div>
            <div className="flex-1" />
            <span className="text-[10px] text-muted-foreground">
              {result.durationMs}ms
            </span>
            <Button variant="ghost" size="sm" onClick={onExportCsv} className="gap-1.5 text-xs h-7">
              <Download size={12} />
              CSV
            </Button>
          </>
        ) : null}
      </div>

      {/* Tabs */}
      {result && (
        <>
          <div className="flex border-b px-2">
            <button
              type="button"
              onClick={() => setActiveTab('results')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === 'results'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Table2 size={12} />
              {t('cohorts.results_table')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('attrition')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === 'attrition'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <BarChart3 size={12} />
              {t('cohorts.results_attrition')}
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            {activeTab === 'results' ? (
              <ResultsTable rows={result.rows} />
            ) : (
              <AttritionChart attrition={result.attrition} />
            )}
          </div>
        </>
      )}
    </div>
  )
}
