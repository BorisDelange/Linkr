import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ConceptDataTable,
  type ConceptColumn,
  type ConceptColumnFilter,
} from '@/components/ui/concept-data-table'
import { formatDateTimeLocale } from '@/lib/format-helpers'
import { columnLabel } from '@/lib/format-helpers'

interface ResultsTableProps {
  rows: Record<string, unknown>[]
}

type Row = Record<string, unknown>

/** Columns the cohort SELECT emits, in the order it emits them. Anything else a
 *  custom SQL returns falls through to a text column keyed on its own name. */
const DATE_COLUMNS = new Set(['start_date', 'end_date'])
const NUMERIC_COLUMNS = new Set(['id', 'patient_id', 'age_at_admission', 'age_current'])

/** Translated header for the generated columns; other keys keep their raw name
 *  prettified, since custom SQL can select anything. */
function headerFor(key: string, t: (k: string) => string): string {
  switch (key) {
    case 'id':
      return t('cohorts.results_col_id')
    case 'patient_id':
      return t('cohorts.results_col_patient')
    case 'gender':
      return t('cohorts.criteria_sex')
    case 'age_at_admission':
      return t('cohorts.results_col_age_admission')
    case 'age_current':
      return t('cohorts.results_col_age_current')
    case 'start_date':
      return t('cohorts.results_col_start')
    case 'end_date':
      return t('cohorts.results_col_end')
    default:
      return columnLabel(key)
  }
}

export function ResultsTable({ rows }: ResultsTableProps) {
  const { t, i18n } = useTranslation()

  const columns = useMemo<ConceptColumn<Row>[]>(() => {
    if (rows.length === 0) return []
    return Object.keys(rows[0]).map((key) => {
      // Dates sort on the raw ISO string (lexicographic = chronological) but are
      // shown in the app's language, so the table stays sortable while readable.
      const isDate = DATE_COLUMNS.has(key)
      const isNumeric = NUMERIC_COLUMNS.has(key)
      const filter: ConceptColumnFilter =
        key === 'gender' ? 'select' : isNumeric ? 'number' : 'text'

      return {
        id: key,
        header: headerFor(key, t),
        accessor: (row) => {
          const v = row[key]
          if (v == null) return null
          return isNumeric ? Number(v) : String(v)
        },
        cell: (row) => {
          const v = row[key]
          if (v == null) return <span className="text-muted-foreground/50">—</span>
          if (isDate) return formatDateTimeLocale(String(v), i18n.language)
          if (isNumeric) return <span className="tabular-nums">{String(v)}</span>
          return String(v)
        },
        // The renderer only reformats text, so the tooltip keeps showing the
        // full value rather than being suppressed by the custom cell.
        tooltip: isNumeric ? 'tabular-nums' : true,
        filter,
        size: isDate ? 160 : isNumeric ? 110 : 130,
        minSize: 70,
      }
    })
  }, [rows, t, i18n.language])

  return (
    <ConceptDataTable
      data={rows}
      columns={columns}
      rowKey={(row) => String(row.id ?? JSON.stringify(row))}
      emptyMessage={t('cohorts.results_none')}
      pageSize={50}
    />
  )
}
