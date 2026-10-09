import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { inferSurveySchema } from '@/lib/survey/survey-infer'
import { questionColumns } from '@/lib/survey/survey-schema'
import { questionKindLabel } from '@/lib/survey/question-kind-label'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The hint shown beside each option in a column picker.
 *
 * Defaults to the column's storage type, which is what someone choosing a
 * column to plot wants. A plugin can ask for `survey` instead, and get the type
 * of the QUESTION the column belongs to — "number" says nothing about a
 * questionnaire, and a multiple-choice question spans several columns, which no
 * storage type can express.
 */
export function useColumnHint(
  field: PluginConfigField,
  columns: DatasetColumn[],
  rows: Record<string, unknown>[] | undefined,
): (col: DatasetColumn) => string {
  const { t } = useTranslation()
  const schema = useMemo(
    () => (field.optionHint === 'survey' ? inferSurveySchema(columns, rows ?? []) : null),
    [field.optionHint, columns, rows],
  )
  return useCallback(
    (col: DatasetColumn) => {
      if (!schema) return col.type
      const question = schema.questions.find(q => questionColumns(q).includes(col.id))
      return question ? questionKindLabel(question, t) : col.type
    },
    [schema, t],
  )
}

export function filterColumns(
  columns: DatasetColumn[],
  filter?: 'numeric' | 'categorical',
): DatasetColumn[] {
  if (!filter) return columns
  if (filter === 'numeric') return columns.filter(c => c.type === 'number')
  // categorical
  return columns.filter(c => c.type === 'string' || c.type === 'boolean')
}
