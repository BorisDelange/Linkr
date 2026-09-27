import { useTranslation } from 'react-i18next'
import { Users, BarChart3, Table2, Download, Loader2, AlertCircle, Contact, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResultsTable } from './ResultsTable'
import { AttritionChart } from './AttritionChart'
import { CUSTOM_SQL_NO_ID } from '@/lib/duckdb/cohort-query'
import type { CohortExecutionResult } from '@/types'
import { useState, type ReactNode } from 'react'

interface ResultsPanelProps {
  result: CohortExecutionResult | null
  loading: boolean
  /** Message from the last failed run, if any. */
  error?: string | null
  onExecute: () => void
  onExportCsv: () => void
  /** A third tab reviewing the result's patients, where the host has a board to
   *  show them through (a database's cohorts). Rendered only while it is open. */
  renderPatients?: (result: CohortExecutionResult) => ReactNode
  /** A tab browsing every table of the database, filtered on the cohort. */
  renderTables?: () => ReactNode
}

type ResultsTab = 'results' | 'attrition' | 'patients' | 'tables'

export function ResultsPanel({ result, loading, error, onExecute, onExportCsv, renderPatients, renderTables }: ResultsPanelProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ResultsTab>('results')
  const tabs: { id: ResultsTab; label: string; icon: typeof Users }[] = [
    { id: 'results', label: t('cohorts.results_table'), icon: Table2 },
    { id: 'attrition', label: t('cohorts.results_attrition'), icon: BarChart3 },
    ...(renderPatients ? [{ id: 'patients' as const, label: t('cohorts.results_patients'), icon: Contact }] : []),
    ...(renderTables ? [{ id: 'tables' as const, label: t('cohorts.results_tables'), icon: Database }] : []),
  ]

  if (!result && !loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        {error ? (
          <>
            <AlertCircle size={32} className="text-destructive opacity-70" />
            <p className="text-sm font-medium text-foreground">
              {t('cohorts.results_failed')}
            </p>
            <p className="max-w-md break-words text-xs">
              {error === 'EMPTY_QUERY'
                ? t('cohorts.results_empty_query')
                : error.startsWith(`${CUSTOM_SQL_NO_ID}:`)
                  ? t('cohorts.results_custom_sql_no_id', { column: error.slice(CUSTOM_SQL_NO_ID.length + 1) })
                  : error}
            </p>
          </>
        ) : (
          <>
            <Users size={32} className="opacity-30" />
            <p className="text-sm">{t('cohorts.results_empty')}</p>
          </>
        )}
        <Button size="sm" onClick={onExecute} className="gap-1.5">
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
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
            <Button variant="ghost" size="sm" onClick={onExportCsv} className="h-6 gap-1 text-xs">
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
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>

          {/* The results table scrolls and paginates internally; the attrition
              chart is a plain block that still needs the scroll container. */}
          {activeTab === 'results' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {/* Showing a truncated page as if it were the whole cohort is the
                  bug this replaces — say so when rows were left behind. */}
              {result.totalCount > result.rows.length && (
                <p className="shrink-0 border-b bg-muted/40 px-4 py-1.5 text-[10px] text-muted-foreground">
                  {t('cohorts.results_truncated', {
                    shown: result.rows.length.toLocaleString(),
                    total: result.totalCount.toLocaleString(),
                  })}
                </p>
              )}
              <div className="min-h-0 flex-1 overflow-hidden">
                <ResultsTable rows={result.rows} />
              </div>
            </div>
          ) : activeTab === 'patients' && renderPatients ? (
            <div className="min-h-0 flex-1 overflow-hidden">{renderPatients(result)}</div>
          ) : activeTab === 'tables' && renderTables ? (
            <div className="min-h-0 flex-1 overflow-hidden">{renderTables()}</div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <AttritionChart attrition={result.attrition} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
