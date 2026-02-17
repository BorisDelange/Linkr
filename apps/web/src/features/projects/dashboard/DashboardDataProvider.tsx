import { createContext, useContext, useMemo } from 'react'
import type { DatasetColumn, FilterValue } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
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
  children: React.ReactNode
}

export function DashboardDataProvider({ datasetFileId, children }: DashboardDataProviderProps) {
  const { files, getFileRows } = useDatasetStore()
  const { activeFilters } = useDashboardStore()

  const datasetFile = files.find((f) => f.id === datasetFileId)
  const columns = datasetFile?.columns ?? []
  const rows = datasetFileId ? getFileRows(datasetFileId) : []

  const filteredRows = useMemo(
    () => applyFilters(rows, activeFilters),
    [rows, activeFilters]
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
