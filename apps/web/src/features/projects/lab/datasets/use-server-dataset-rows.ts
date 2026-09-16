import { useEffect, useRef, useState } from 'react'
import {
  queryDatasetRows,
  type ServerRowFilter,
  type ServerRowsQuery,
} from '@/lib/api/datasets'
import { isCategoricalFilter, type ColumnFilterValue } from './ColumnFilterInput'
import type { DatasetColumn } from '@/types'

interface Params {
  fileId: string
  page: number
  pageSize: number
  sort: { colId: string; dir: 'asc' | 'desc' } | null
  columnFilters: Record<string, ColumnFilterValue>
  naFilters: Record<string, 'exclude' | 'only'>
  columns: DatasetColumn[]
  /** Bumped when the dataset's content changes (an edit op), to force a refetch. */
  revision?: number
}

export interface ServerRowsState {
  rows: Record<string, unknown>[]
  total: number
  loading: boolean
  error: string | null
}

/** Translate DatasetTable's UI filter values into the server query shape. */
export function toServerFilters(
  columnFilters: Record<string, ColumnFilterValue>,
  columns: DatasetColumn[],
): ServerRowFilter[] {
  const typeById = new Map(columns.map((c) => [c.id, c.type]))
  const out: ServerRowFilter[] = []
  for (const [colId, value] of Object.entries(columnFilters)) {
    if (value == null) continue
    if (isCategoricalFilter(value)) {
      if (value.in.length > 0) out.push({ colId, values: value.in })
      continue
    }
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
  revision = 0,
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

  // The debounce exists for TYPING in a filter box. An edit is a discrete action
  // that already happened, so making it wait out the same delay just leaves the
  // stale value on screen for another quarter second. Paging and sorting are
  // discrete in the same way — a click, not a keystroke — and waiting out the
  // delay there is felt directly as the table lagging behind the pager.
  const fetchedRevision = useRef(revision)
  const fetchedDiscrete = useRef('')
  /** The dataset the rows in state belong to, so a switch can clear them. */
  const fetchedFile = useRef(fileId)

  useEffect(() => {
    const discreteKey = `${fileId}|${page}|${pageSize}|${sortKey}`
    const immediate =
      fetchedRevision.current !== revision || fetchedDiscrete.current !== discreteKey
    fetchedRevision.current = revision
    fetchedDiscrete.current = discreteKey
    const id = ++reqId.current
    const query: ServerRowsQuery = {
      offset: page * pageSize,
      limit: pageSize,
      sort: sort ?? undefined,
      filters: toServerFilters(columnFilters, columns),
      na: Object.entries(naFilters).map(([colId, mode]) => ({ colId, mode })),
    }
    // Keep the rows on screen while re-querying the SAME dataset — paging and
    // filtering stay steady rather than blinking through an empty table. Drop them
    // when the dataset itself changes: they belong to the previous file, and the
    // columns beside them have already switched, so they would be rendered under
    // headers they have nothing to do with.
    const sameFile = fetchedFile.current === fileId
    fetchedFile.current = fileId
    setState((s) => (sameFile
      ? { ...s, loading: true, error: null }
      : { rows: [], total: 0, loading: true, error: null }))
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
    }, immediate ? 0 : 250)
    return () => clearTimeout(timer)
    // `revision` is what makes an EDIT visible: rows are materialised server-side
    // from the ops log, so recording one changes what this query returns without
    // changing any of its other inputs. Without it a committed cell snapped back
    // to the stale page still held here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, page, pageSize, sortKey, filtersKey, naKey, revision])

  return state
}
