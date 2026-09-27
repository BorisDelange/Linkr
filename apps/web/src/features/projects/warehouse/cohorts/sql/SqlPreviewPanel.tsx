import { useMemo } from 'react'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { buildCohortCountSql } from '@/lib/duckdb/cohort-query'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  onCustomSqlChange: (sql: string | null) => void
  onExecute: () => void
}

export function SqlPreviewPanel({ cohort, mapping, onCustomSqlChange, onExecute }: SqlPreviewPanelProps) {
  // Auto-generated SQL from criteria tree
  const autoSql = useMemo(() => (mapping ? buildCohortCountSql(cohort, mapping) : null), [cohort, mapping])
  return (
    <GeneratedSqlEditor
      generatedSql={autoSql}
      customSql={cohort.customSql}
      onCustomSqlChange={onCustomSqlChange}
      onRun={onExecute}
    />
  )
}
