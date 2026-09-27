import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { buildCohortCriteriaSql, levelIdNames } from '@/lib/duckdb/cohort-query'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { cn } from '@/lib/utils'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  onCustomSqlChange: (sql: string | null) => void
  onExecute: () => void
}

type SqlView = 'linkr' | 'native'

export function SqlPreviewPanel({ cohort, mapping, onCustomSqlChange, onExecute }: SqlPreviewPanelProps) {
  const { t } = useTranslation()
  const [view, setView] = useState<SqlView>('linkr')
  const autoSql = useMemo(() => (mapping ? buildCohortCriteriaSql(cohort, mapping) : null), [cohort, mapping])
  const names = mapping && cohort.level !== 'event' ? levelIdNames(cohort.level, mapping) : []
  // The Linkr tables spelled out over the database's own: what actually runs.
  const nativeSql = useMemo(() => {
    const sql = cohort.customSql ?? autoSql
    return sql && mapping ? withClassRelations(sql, mapping) : ''
  }, [cohort.customSql, autoSql, mapping])

  const contract = cohort.level === 'event'
    ? t('cohorts.sql_contract_event')
    : names.length > 1
      ? t('cohorts.sql_contract_native', { column: names[0], native: names[1] })
      : t('cohorts.sql_contract', { column: names[0] ?? '' })

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b px-3 py-1.5">
        <p className="flex-1 text-xs text-muted-foreground">{contract}</p>
        <div className="flex shrink-0 items-center rounded-md border p-0.5">
          {(['linkr', 'native'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              title={t(`cohorts.sql_view_${v}_hint`)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px] transition-colors',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`cohorts.sql_view_${v}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'linkr' ? (
          <GeneratedSqlEditor
            generatedSql={autoSql}
            customSql={cohort.customSql}
            onCustomSqlChange={onCustomSqlChange}
            onRun={onExecute}
          />
        ) : (
          <CodeEditor language="sql" value={nativeSql} readOnly />
        )}
      </div>
    </div>
  )
}
