import { useEffect, useState } from 'react'
import { fetchColumnDistinct } from '@/lib/api/datasets'
import { isServerMode } from '@/lib/api-client'
import type { DatasetColumn } from '@/types'

/** A column filtered by a checkbox list needs its distinct values; a string
 *  column auto-qualifies as "categorical" only under this many distinct values. */
export const CATEGORICAL_MAX_DISTINCT = 100

interface Params {
  fileId: string
  columns: DatasetColumn[]
  /** Column ids that render a list (multi-select) filter and need options. */
  listColumnIds: string[]
  /** In-memory rows (front-only mode); empty in server mode. */
  rows: Record<string, unknown>[]
  /** Bumps when the in-memory rows change (cell edit / row add), so local-mode
   *  distinct options refresh. Ignored in server mode. */
  dataVersion?: number
}

/**
 * Distinct values per list-mode column, keyed by columnId.
 *
 * Server mode fetches DISTINCT server-side (capped, no raw rows shipped); local
 * mode scans the in-memory rows. Returns `{}` entries until loaded. Columns that
 * exceed the cap come back `truncated` (still usable via the search box).
 */
export function useColumnDistinct({ fileId, columns, listColumnIds, rows, dataVersion }: Params) {
  const [options, setOptions] = useState<Record<string, string[]>>({})
  const key = listColumnIds.slice().sort().join(',')

  useEffect(() => {
    if (listColumnIds.length === 0) {
      setOptions({})
      return
    }
    let cancelled = false

    if (!isServerMode()) {
      const colIds = new Set(columns.map((c) => c.id))
      const next: Record<string, string[]> = {}
      for (const colId of listColumnIds) {
        if (!colIds.has(colId)) continue
        const seen = new Set<string>()
        for (const row of rows) {
          const v = row[colId]
          if (v == null || v === '') continue
          seen.add(String(v))
          if (seen.size > CATEGORICAL_MAX_DISTINCT) break
        }
        next[colId] = [...seen].sort((a, b) => a.localeCompare(b))
      }
      setOptions(next)
      return
    }

    Promise.all(
      listColumnIds.map((colId) =>
        fetchColumnDistinct(fileId, colId, { limit: CATEGORICAL_MAX_DISTINCT })
          .then((res) => [colId, res.values] as const)
          .catch(() => [colId, [] as string[]] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setOptions(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, key, dataVersion])

  return options
}
