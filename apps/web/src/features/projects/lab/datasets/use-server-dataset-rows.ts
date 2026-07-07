import { useEffect, useRef, useState } from 'react'
import {
  queryDatasetRows,
  type ServerRowFilter,
  type ServerRowsQuery,
} from '@/lib/api/datasets'
import type { ColumnFilterValue } from './ColumnFilterInput'
import type { DatasetColumn } from '@/types'

interface Params {
  fileId: string
  page: number
  pageSize: number
  sort: { colId: string; dir: 'asc' | 'desc' } | null
  columnFilters: Record<string, ColumnFilterValue>
  naFilters: Record<string, 'exclude' | 'only'>
  columns: DatasetColumn[]
}

export interface ServerRowsState {
  rows: Record<string, unknown>[]
  total: number
  loading: boolean
  error: string | null
}

/** Translate DatasetTable's UI filter values into the server query shape. */
function toServerFilters(
  columnFilters: Record<string, ColumnFilterValue>,
  columns: DatasetColumn[],
): ServerRowFilter[] {
  const typeById = new Map(columns.map((c) => [c.id, c.type]))
  const out: ServerRowFilter[] = []
  for (const [colId, value] of Object.entries(columnFilters)) {
    if (value == null) continue
    const type = typeById.get(colId)
    if (type === 'number') {
      const { min, max } = value as { min?: number; max?: number }
      out.push({ colId, min, max })
    } else if (type === 'date') {
      const { from, to } = value as { from?: string; to?: string }
      out.push({ colId, from, to })
    } else {
      out.push({ colId, value: String(value) })
    }
  }
  return out
}

/**
 * Fetch one page of rows from the server whenever page/sort/filters change.
 * Filter changes are debounced so typing doesn't fire a request per keystroke.
 * A monotonic request id guards against out-of-order responses.
 */
export function useServerDatasetRows({
  fileId,
  page,
  pageSize,
  sort,
  columnFilters,
  naFilters,
  columns,
}: Params): ServerRowsState {
  const [state, setState] = useState<ServerRowsState>({
    rows: [],
    total: 0,
    loading: true,
    error: null,
  })
  const reqId = useRef(0)

  const filtersKey = JSON.stringify(columnFilters)
  const naKey = JSON.stringify(naFilters)
  const sortKey = sort ? `${sort.colId}:${sort.dir}` : ''

  useEffect(() => {
    const id = ++reqId.current
    const query: ServerRowsQuery = {
      offset: page * pageSize,
      limit: pageSize,
      sort: sort ?? undefined,
      filters: toServerFilters(columnFilters, columns),
      na: Object.entries(naFilters).map(([colId, mode]) => ({ colId, mode })),
    }
    setState((s) => ({ ...s, loading: true, error: null }))
    const timer = setTimeout(() => {
      queryDatasetRows(fileId, query)
        .then((page) => {
          if (id !== reqId.current) return
          setState({ rows: page.rows, total: page.total, loading: false, error: null })
        })
        .catch((e) => {
          if (id !== reqId.current) return
          setState({ rows: [], total: 0, loading: false, error: String(e) })
        })
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, page, pageSize, sortKey, filtersKey, naKey])

  return state
}
