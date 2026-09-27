import { useTranslation } from 'react-i18next'
import { Users, BarChart3, Table2, Download, Loader2, AlertCircle, Contact, Database, Terminal, FolderTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResultsTable } from './ResultsTable'
import { AttritionChart } from './AttritionChart'
import { CUSTOM_SQL_NO_ID } from '@/lib/duckdb/cohort-query'
import type { CohortExecutionResult, CustomSqlOutput } from '@/types'
import { useState, type ReactNode } from 'react'

interface ResultsPanelProps {
  result: CohortExecutionResult | null
  loading: boolean
  /** Message from the last failed run, if any. */
  error?: string | null
  /** The hand-written query's own rows, from the last run. */
  output?: CustomSqlOutput | null
  onExecute: () => void
  onExportCsv: () => void
  /** A tab reviewing the result's patients, where the host has a board to
   *  show them through (a database's cohorts). Rendered only while it is open. */
  renderPatients?: (result: CohortExecutionResult) => ReactNode
  /** A tab browsing every table of the database, filtered on the cohort. */
  renderTables?: () => ReactNode
  /** A tab browsing the database's schema, unfiltered. */
  renderSchema?: () => ReactNode
}

type ResultsTab = 'results' | 'attrition' | 'patients' | 'tables' | 'output' | 'schema'

/** The tabs that read the cohort's members, and so show its error. */
const MEMBER_TABS: ResultsTab[] = ['results', 'attrition', 'patients', 'tables']

export function ResultsPanel({
  result, loading, error, output, onExecute, onExportCsv, renderPatients, renderTables, renderSchema,
}: ResultsPanelProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ResultsTab>('results')
  const tabs: { id: ResultsTab; label: string; icon: typeof Users }[] = [
    { id: 'results', label: t('cohorts.results_table'), icon: Table2 },
    { id: 'attrition', label: t('cohorts.results_attrition'), icon: BarChart3 },
    ...(renderPatients ? [{ id: 'patients' as const, label: t('cohorts.results_patients'), icon: Contact }] : []),
    ...(renderTables ? [{ id: 'tables' as const, label: t('cohorts.results_tables'), icon: Database }] : []),
    { id: 'output', label: t('cohorts.results_output'), icon: Terminal },
    ...(renderSchema ? [{ id: 'schema' as const, label: t('cohorts.results_schema'), icon: FolderTree }] : []),
  ]
  const tab = tabs.some((x) => x.id === activeTab) ? activeTab : 'results'
  // Kept mounted once opened: going back to it must not reload the database's tables.
  const [schemaOpened, setSchemaOpened] = useState(false)
  if (tab === 'schema' && !schemaOpened) setSchemaOpened(true)

  // A query that reads a table without listing members (SELECT * FROM
  // measurement) fails as a cohort: open its rows rather than only the error.
  const [seenOutput, setSeenOutput] = useState(output)
  if (seenOutput !== output) {
    setSeenOutput(output)
    if (output && !output.error && error?.startsWith(`${CUSTOM_SQL_NO_ID}:`) && MEMBER_TABS.includes(tab)) {
      setActiveTab('output')
    }
  }

  const errorText = !error
    ? null
    : error === 'EMPTY_QUERY'
      ? t('cohorts.results_empty_query')
      : error.startsWith(`${CUSTOM_SQL_NO_ID}:`)
        ? t('cohorts.results_custom_sql_no_id', { column: error.slice(CUSTOM_SQL_NO_ID.length + 1) })
        : error

  const spinner = (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 size={14} className="animate-spin" />
      {t('cohorts.executing')}
    </div>
  )

  /** What a tab reading the members shows before, or instead of, the members. */
  const membersState = (): ReactNode => {
    if (loading && !result) return spinner
    if (errorText) {
      return (
        <CenteredState>
          <AlertCircle size={32} className="text-destructive opacity-70" />
          <p className="text-sm font-medium text-foreground">{t('cohorts.results_failed')}</p>
          <p className="max-w-md break-words text-xs">{errorText}</p>
          <div className="flex gap-2">
            {output && !output.error && (
              <Button size="sm" variant="outline" onClick={() => setActiveTab('output')}>
                {t('cohorts.results_see_output')}
              </Button>
            )}
            <Button size="sm" onClick={onExecute}>{t('cohorts.execute')}</Button>
          </div>
        </CenteredState>
      )
    }
    if (!result) {
      return (
        <CenteredState>
          <Users size={32} className="opacity-30" />
          <p className="text-sm">{t('cohorts.results_empty')}</p>
          <Button size="sm" onClick={onExecute}>{t('cohorts.execute')}</Button>
        </CenteredState>
      )
    }
    return null
  }

  const content = (): ReactNode => {
    if (tab === 'schema') return null
    if (tab === 'output') {
      if (loading && !output) return spinner
      if (!output) {
        return (
          <CenteredState>
            <Terminal size={32} className="opacity-30" />
            <p className="max-w-md text-xs">{t('cohorts.results_output_empty')}</p>
          </CenteredState>
        )
      }
      if (output.error) return <p className="p-4 break-words font-mono text-xs text-destructive">{output.error}</p>
      return (
        <div className="flex h-full flex-col">
          <p className="shrink-0 border-b bg-muted/40 px-4 py-1.5 text-[10px] text-muted-foreground">
            {output.truncated
              ? t('cohorts.results_output_truncated', { count: output.rows.length, ms: output.durationMs })
              : t('cohorts.results_output_rows', { count: output.rows.length, ms: output.durationMs })}
          </p>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ResultsTable rows={output.rows} rawHeaders emptyMessage={t('cohorts.results_output_none')} />
          </div>
        </div>
      )
    }
    const state = membersState()
    if (state || !result) return state
    if (tab === 'tables' && renderTables) return renderTables()
    if (tab === 'patients' && renderPatients) return renderPatients(result)
    if (tab === 'attrition') {
      return (
        <div className="h-full overflow-auto">
          <AttritionChart attrition={result.attrition} />
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col">
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
    )
  }

  return (
    <div className="flex h-full flex-col">
      {(loading || result) && (
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
              <span className="text-[10px] text-muted-foreground">{result.durationMs}ms</span>
              <Button variant="ghost" size="sm" onClick={onExportCsv} className="h-6 gap-1 text-xs">
                <Download size={12} />
                CSV
              </Button>
            </>
          ) : null}
        </div>
      )}

      <div className="flex border-b px-2">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab !== 'schema' && content()}
        {/* Hidden, not collapsed: a zero width would make its panes forget
            their sizes. */}
        {schemaOpened && renderSchema && (
          <div className={tab === 'schema' ? 'absolute inset-0' : 'invisible absolute inset-0'}>{renderSchema()}</div>
        )}
      </div>
    </div>
  )
}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      {children}
    </div>
  )
}
