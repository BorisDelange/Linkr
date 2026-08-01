import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { DatasetColumn, FilterValue } from '@/types'
import { useDatasetStore } from '@/stores/dataset-store'
import { resolveRelativeWindow } from './date-presets'

interface DashboardDataContextValue {
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  filteredRows: Record<string, unknown>[]
  hasDataset: boolean
  datasetFileId: string | null
  filters: Record<string, FilterValue>
  /** When true, widgets re-run on every (re)mount instead of reusing their cached result. */
  reloadOnTabSwitch: boolean
  /** Stable fingerprint of the data feeding widgets (dataset + active filters). Part of the
   *  execution cache key, so widgets re-run when the filtered data actually changes. */
  dataSignature: string
}

const DashboardDataContext = createContext<DashboardDataContextValue>({
  columns: [],
  rows: [],
  filteredRows: [],
  hasDataset: false,
  datasetFileId: null,
  filters: {},
  reloadOnTabSwitch: false,
  dataSignature: '',
})

export function useDashboardData() {
  return useContext(DashboardDataContext)
}

// Sentinel value stored in a categorical filter's `selected` to mean "nothing selected →
// no results", as opposed to `[]` which means "no restriction". The reserved token name
// makes collision with a real cell value effectively impossible.
export const FILTER_NONE = '__linkr_filter_none__'

export function applyFilters(
  rows: Record<string, unknown>[],
  activeFilters: Record<string, FilterValue>,
): Record<string, unknown>[] {
  const entries = Object.entries(activeFilters)
  if (entries.length === 0) return rows

  return rows.filter((row) => {
    for (const [columnId, filter] of entries) {
      const value = row[columnId]

      switch (filter.type) {
        case 'categorical': {
          // Sentinel meaning "explicitly nothing selected" → exclude every row. Distinct from
          // an empty list, which means "no restriction" (all pass) for dropdown-style inputs.
          if (filter.selected.length === 1 && filter.selected[0] === FILTER_NONE) return false
          if (filter.selected.length === 0) continue // no filter active
          if (!filter.selected.includes(String(value ?? ''))) return false
          break
        }
        case 'numeric': {
          const num = Number(value)
          if (isNaN(num)) return false
          if (filter.min != null && num < filter.min) return false
          if (filter.max != null && num > filter.max) return false
          break
        }
        case 'numeric-double': {
          const num = Number(value)
          if (isNaN(num)) return false
          const inRange = (min: number | null, max: number | null) =>
            (min == null && max == null) ? false : (min == null || num >= min) && (max == null || num <= max)
          // A range with both bounds empty is "unused"; pass if the row falls in either active range.
          const used1 = filter.min1 != null || filter.max1 != null
          const used2 = filter.min2 != null || filter.max2 != null
          if (!used1 && !used2) break // no restriction
          if (!(inRange(filter.min1, filter.max1) || inRange(filter.min2, filter.max2))) return false
          break
        }
        case 'date': {
          const dateStr = String(value ?? '')
          if (filter.from && dateStr < filter.from) return false
          if (filter.to && dateStr > filter.to) return false
          break
        }
        case 'date-relative': {
          const { from, to } = resolveRelativeWindow(filter.count, filter.unit)
          // Compare on the date part only, so timestamps within the end day still match.
          const dateStr = String(value ?? '').slice(0, 10)
          if (dateStr < from || dateStr > to) return false
          break
        }
      }
    }
    return true
  })
}

interface DashboardDataProviderProps {
  datasetFileId: string | null
  /** Filters to apply, keyed by column ID (not filter ID). */
  filters?: Record<string, FilterValue>
  /** Propagated to widget renderers to control result caching across tab switches. */
  reloadOnTabSwitch?: boolean
  children: React.ReactNode
}

export function DashboardDataProvider({ datasetFileId, filters, reloadOnTabSwitch = false, children }: DashboardDataProviderProps) {
  const { files, getFileRows, loadFileData, ensureServerMeta } = useDatasetStore()
  const [dataReady, setDataReady] = useState(false)

  // Ensure row data is loaded from IDB (needed after app restart)
  useEffect(() => {
    if (!datasetFileId) { setDataReady(true); return }
    setDataReady(false)
    loadFileData(datasetFileId).then(() => setDataReady(true))
  }, [datasetFileId, loadFileData])

  // Server mode lists datasets without columns; hydrate them for this widget's
  // dataset so `columns` below isn't empty (loadFileData is a no-op in server mode).
  useEffect(() => {
    if (datasetFileId) ensureServerMeta(datasetFileId)
  }, [datasetFileId, ensureServerMeta])

  const datasetFile = files.find((f) => f.id === datasetFileId)
  const columns = dataReady ? (datasetFile?.columns ?? []) : []
  const rows = dataReady && datasetFileId ? getFileRows(datasetFileId) : []

  const filteredRows = useMemo(
    () => filters ? applyFilters(rows, filters) : rows,
    [rows, filters]
  )

  // Cheap fingerprint of the data feeding widgets: dataset, row count, and the active filter
  // values. Used in the execution cache key so a filter change re-runs widgets, but switching
  // tabs (same dataset + filters) does not.
  const dataSignature = useMemo(
    () => `${datasetFileId ?? ''}|${filteredRows.length}|${JSON.stringify(filters ?? {})}`,
    [datasetFileId, filteredRows.length, filters]
  )

  const value = useMemo(
    () => ({
      columns,
      rows,
      filteredRows,
      hasDataset: !!datasetFileId,
      // Exposed for server mode: widgets send the datasetFileId + resolved filters
      // to the backend instead of shipping filteredRows.
      datasetFileId: datasetFileId ?? null,
      filters: filters ?? {},
      reloadOnTabSwitch,
      dataSignature,
    }),
    [columns, rows, filteredRows, datasetFileId, filters, reloadOnTabSwitch, dataSignature]
  )

  return (
    <DashboardDataContext.Provider value={value}>
      {children}
    </DashboardDataContext.Provider>
  )
}
