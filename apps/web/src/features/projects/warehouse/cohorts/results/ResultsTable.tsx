import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ConceptDataTable,
  type ConceptColumn,
  type ConceptColumnFilter,
} from '@/components/ui/concept-data-table'
import { columnLabel, formatDate, formatDateTimeLocale } from '@/lib/format-helpers'

interface ResultsTableProps {
  rows: Record<string, unknown>[]
}

type Row = Record<string, unknown>

/** Columns the cohort SELECT emits, in the order it emits them. Anything else a
 *  custom SQL returns falls through to a text column keyed on its own name. */
const DATE_COLUMNS = new Set(['start_date', 'end_date'])
const NUMERIC_COLUMNS = new Set(['id', 'patient_id', 'age_at_admission', 'age_current'])

/** `2159-03-20T21:08:00`, with or without the time — what the engine serializes
 *  a DuckDB DATE/TIMESTAMP to. Detected by shape so a custom SQL's own date
 *  column is formatted too, not just the two the generated query emits. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/

function isDateValue(v: unknown): boolean {
  return typeof v === 'string' && ISO_DATE_RE.test(v)
}

/** Whether an ISO value carries a time, not just a day. */
function hasTime(v: string): boolean {
  return /[T ]\d{2}:\d{2}/.test(v)
}

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
      // Named columns are always dates; anything else is judged on the first
      // non-null value it actually holds.
      const isDate =
        DATE_COLUMNS.has(key) || isDateValue(rows.find((r) => r[key] != null)?.[key])
      const isNumeric = NUMERIC_COLUMNS.has(key)
      const filter: ConceptColumnFilter =
        key === 'gender' ? 'select' : isNumeric ? 'number' : 'text'

      return {
        id: key,
        header: headerFor(key, t),
        // Dates sort on the raw ISO value (lexicographic = chronological) but
        // are read in the app's language, so `display` carries the formatting
        // rather than a `cell` renderer, which the tooltip path would discard.
        accessor: (row) => {
          const v = row[key]
          if (v == null) return null
          return isNumeric ? Number(v) : String(v)
        },
        display: (row) => {
          const v = row[key]
          if (v == null) return '—'
          if (!isDate) return String(v)
          const s = String(v)
          // A date with no time must not gain one: `new Date('2159-03-20')`
          // parses as UTC midnight, which prints as 01:00 in a +1 timezone.
          return hasTime(s)
            ? formatDateTimeLocale(s, i18n.language)
            : formatDate(s, i18n.language)
        },
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
      pageSize={100}
    />
  )
}
