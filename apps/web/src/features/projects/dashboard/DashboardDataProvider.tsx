import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { DatasetColumn, FilterValue } from '@/types'
import { useDatasetStore } from '@/stores/dataset-store'

interface DashboardDataContextValue {
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  filteredRows: Record<string, unknown>[]
  hasDataset: boolean
}

const DashboardDataContext = createContext<DashboardDataContextValue>({
  columns: [],
  rows: [],
  filteredRows: [],
  hasDataset: false,
})

export function useDashboardData() {
  return useContext(DashboardDataContext)
}

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
        case 'date': {
          const dateStr = String(value ?? '')
          if (filter.from && dateStr < filter.from) return false
          if (filter.to && dateStr > filter.to) return false
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
  children: React.ReactNode
}

export function DashboardDataProvider({ datasetFileId, filters, children }: DashboardDataProviderProps) {
  const { files, getFileRows, loadFileData } = useDatasetStore()
  const [dataReady, setDataReady] = useState(false)

  // Ensure row data is loaded from IDB (needed after app restart)
  useEffect(() => {
    if (!datasetFileId) { setDataReady(true); return }
    setDataReady(false)
    loadFileData(datasetFileId).then(() => setDataReady(true))
  }, [datasetFileId, loadFileData])

  const datasetFile = files.find((f) => f.id === datasetFileId)
  const columns = dataReady ? (datasetFile?.columns ?? []) : []
  const rows = dataReady && datasetFileId ? getFileRows(datasetFileId) : []

  const filteredRows = useMemo(
    () => filters ? applyFilters(rows, filters) : rows,
    [rows, filters]
  )

  const value = useMemo(
    () => ({
      columns,
      rows,
      filteredRows,
      hasDataset: !!datasetFileId,
    }),
    [columns, rows, filteredRows, datasetFileId]
  )

  return (
    <DashboardDataContext.Provider value={value}>
      {children}
    </DashboardDataContext.Provider>
  )
}
