import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { fetchColumnDistinct } from '@/lib/api/datasets'

const NO_VALUES: string[] = []

/**
 * Server mode: the distinct values of a column, fetched because `rows` is empty
 * there (the browser never holds the dataset). Alphabetical, at most 500. Tagged
 * with the column id so a result for a previous column is never shown.
 */
export function useServerColumnDistinct(colId: string | undefined, rows: Record<string, unknown>[] | undefined, datasetFileId: string | undefined): string[] {
  const [result, setResult] = useState<{ colId: string; values: string[] }>({ colId: '', values: [] })
  const needsServer = isServerMode() && !!datasetFileId && !!colId && (!rows || rows.length === 0)
  useEffect(() => {
    if (!needsServer) return
    let cancelled = false
    fetchColumnDistinct(datasetFileId!, colId!, { limit: 500 })
      .then((res) => { if (!cancelled) setResult({ colId: colId!, values: res.values }) })
      .catch(() => { if (!cancelled) setResult({ colId: colId!, values: [] }) })
    return () => { cancelled = true }
  }, [needsServer, datasetFileId, colId])
  return needsServer && result.colId === colId ? result.values : NO_VALUES
}
