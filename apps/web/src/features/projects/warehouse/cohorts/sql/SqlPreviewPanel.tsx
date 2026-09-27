import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { buildCohortCriteriaSql, cohortIdColumn } from '@/lib/duckdb/cohort-query'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  onCustomSqlChange: (sql: string | null) => void
  /** Runs the editor's text, saved or not (null: the criteria). */
  onExecute: (sql: string | null) => void
  onDraftChange: (sql: string | null | undefined) => void
}

export function SqlPreviewPanel({ cohort, mapping, onCustomSqlChange, onExecute, onDraftChange }: SqlPreviewPanelProps) {
  const { t } = useTranslation()
  const autoSql = useMemo(() => (mapping ? buildCohortCriteriaSql(cohort, mapping) : null), [cohort, mapping])
  return (
    <div className="flex h-full flex-col">
      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
        {cohort.level === 'event'
          ? t('cohorts.sql_contract_event')
          : t('cohorts.sql_contract', {
              column: cohortIdColumn(cohort.level),
              level: t(`cohorts.level_${cohort.level}`).toLowerCase(),
            })}
      </p>
      <div className="flex-1 min-h-0">
        <GeneratedSqlEditor
          generatedSql={autoSql}
          customSql={cohort.customSql}
          onCustomSqlChange={onCustomSqlChange}
          onRun={onExecute}
          onDraftChange={onDraftChange}
        />
      </div>
    </div>
  )
}
