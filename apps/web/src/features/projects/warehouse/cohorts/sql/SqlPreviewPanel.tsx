import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { buildCohortCriteriaSql } from '@/lib/duckdb/cohort-query'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  onCustomSqlChange: (sql: string | null) => void
  onExecute: () => void
}

const LEVEL_ID_COLUMN = { patient: 'patient_id', visit: 'visit_id', visit_detail: 'visit_detail_id' } as const

export function SqlPreviewPanel({ cohort, mapping, onCustomSqlChange, onExecute }: SqlPreviewPanelProps) {
  const { t } = useTranslation()
  const autoSql = useMemo(() => (mapping ? buildCohortCriteriaSql(cohort, mapping) : null), [cohort, mapping])
  return (
    <div className="flex h-full flex-col">
      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
        {cohort.level === 'event'
          ? t('cohorts.sql_contract_event')
          : t('cohorts.sql_contract', {
              level: t(`cohorts.level_${cohort.level}`),
              column: LEVEL_ID_COLUMN[cohort.level],
            })}
      </p>
      <div className="flex-1 min-h-0">
        <GeneratedSqlEditor
          generatedSql={autoSql}
          customSql={cohort.customSql}
          onCustomSqlChange={onCustomSqlChange}
          onRun={onExecute}
        />
      </div>
    </div>
  )
}
