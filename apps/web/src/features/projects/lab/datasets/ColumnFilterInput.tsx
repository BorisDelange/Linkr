import { useTranslation } from 'react-i18next'
import type { DatasetColumn } from '@/types'

const INPUT_CLASS =
  'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

const HALF_INPUT_CLASS =
  'h-6 w-1/2 rounded border border-dashed bg-transparent px-1 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

/** Union of possible filter values per column type. */
export type ColumnFilterValue =
  | string                              // string/unknown text search, boolean select
  | { min?: number; max?: number }      // number range
  | { from?: string; to?: string }      // date/datetime range
  | undefined

export interface ColumnFilterInputProps {
  colId: string
  colType: DatasetColumn['type']
  colName: string
  value: ColumnFilterValue
  onChange: (colId: string, value: ColumnFilterValue) => void
  /** Whether the date column contains time components. */
  isDatetime?: boolean
}

export function ColumnFilterInput({
  colId,
  colType,
  colName,
  value,
  onChange,
  isDatetime,
}: ColumnFilterInputProps) {
  const { t } = useTranslation()

  // Boolean filter
  if (colType === 'boolean') {
    const v = (value as string) ?? ''
    return (
      <select
        className={INPUT_CLASS}
        value={v}
        onChange={(e) => onChange(colId, e.target.value || undefined)}
      >
        <option value="">{t('datasets.filter_all')}</option>
        <option value="true">{t('datasets.filter_true')}</option>
        <option value="false">{t('datasets.filter_false')}</option>
      </select>
    )
  }

  // Number filter (min / max)
  if (colType === 'number') {
    const range = (value as { min?: number; max?: number }) ?? {}
    return (
      <div className="flex gap-0.5">
        <input
          type="number"
          className={HALF_INPUT_CLASS}
          placeholder={t('datasets.filter_min')}
          value={range.min ?? ''}
          onChange={(e) => {
            const v = e.target.value
            const next = { ...range, min: v === '' ? undefined : Number(v) }
            onChange(colId, next.min == null && next.max == null ? undefined : next)
          }}
        />
        <input
          type="number"
          className={HALF_INPUT_CLASS}
          placeholder={t('datasets.filter_max')}
          value={range.max ?? ''}
          onChange={(e) => {
            const v = e.target.value
            const next = { ...range, max: v === '' ? undefined : Number(v) }
            onChange(colId, next.min == null && next.max == null ? undefined : next)
          }}
        />
      </div>
    )
  }

  // Date / datetime filter (from / to)
  if (colType === 'date') {
    const inputType = isDatetime ? 'datetime-local' : 'date'
    const range = (value as { from?: string; to?: string }) ?? {}
    return (
      <div className="flex gap-0.5">
        <input
          type={inputType}
          className={HALF_INPUT_CLASS}
          title={t('datasets.filter_from')}
          value={range.from ?? ''}
          onChange={(e) => {
            const v = e.target.value
            const next = { ...range, from: v || undefined }
            onChange(colId, !next.from && !next.to ? undefined : next)
          }}
        />
        <input
          type={inputType}
          className={HALF_INPUT_CLASS}
          title={t('datasets.filter_to')}
          value={range.to ?? ''}
          onChange={(e) => {
            const v = e.target.value
            const next = { ...range, to: v || undefined }
            onChange(colId, !next.from && !next.to ? undefined : next)
          }}
        />
      </div>
    )
  }

  // String / unknown — text search
  const textValue = (value as string) ?? ''
  return (
    <input
      className={INPUT_CLASS}
      placeholder={`${colName}...`}
      value={textValue}
      onChange={(e) => onChange(colId, e.target.value || undefined)}
    />
  )
}

/**
 * Filter function for DatasetTable columns.
 * Handles type-aware filtering: text search, numeric range, date range, boolean match.
 */
export function applyColumnFilter(
  cellValue: unknown,
  colType: DatasetColumn['type'],
  filterValue: ColumnFilterValue,
): boolean {
  if (filterValue == null) return true

  if (colType === 'number') {
    const { min, max } = filterValue as { min?: number; max?: number }
    if (cellValue == null) return false
    const num = Number(cellValue)
    if (isNaN(num)) return false
    if (min != null && num < min) return false
    if (max != null && num > max) return false
    return true
  }

  if (colType === 'date') {
    const { from, to } = filterValue as { from?: string; to?: string }
    if (cellValue == null) return false
    const str = String(cellValue)
    if (from && str < from) return false
    if (to && str > to) return false
    return true
  }

  if (colType === 'boolean') {
    const target = filterValue as string
    if (!target) return true
    if (cellValue == null) return false
    return String(cellValue).toLowerCase() === target.toLowerCase()
  }

  // string / unknown — text includes
  const term = String(filterValue)
  if (!term) return true
  return String(cellValue ?? '').toLowerCase().includes(term.toLowerCase())
}
