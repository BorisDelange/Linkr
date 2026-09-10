/**
 * The rows of several datasets at once, for a widget plotting more than one.
 *
 * One hook for the whole list rather than one per dataset: the number of datasets a
 * widget plots changes as it is configured, and a hook cannot be called in a loop.
 * The fetches themselves are shared through the module cache below, so two widgets
 * reading the same dataset fetch it once.
 *
 * Front-only holds the dataset in memory; server mode pages it from the Parquet
 * cache. Either way the rows are filtered down to the selected patient by the
 * caller rather than in SQL: a dataset has no schema mapping, so the patient column
 * is whatever the widget's config says it is, and the volumes involved (a
 * hand-collected table) are small enough that fetching once and filtering is
 * simpler than building a query per widget.
 */
import { useEffect, useMemo, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { queryDatasetRows } from '@/lib/api/datasets'
import { useDatasetStore } from '@/stores/dataset-store'

/** Rows fetched per dataset in server mode, so N widgets on one dataset fetch once. */
const cache = new Map<string, Promise<Record<string, unknown>[]>>()

/** A hand-collected table is small; this bounds a misconfiguration, not real data. */
const MAX_ROWS = 50_000

export interface DatasetRows {
  /** Rows by dataset file id. A dataset still loading is absent, not empty. */
  byFileId: Record<string, Record<string, unknown>[]>
  /** Dataset display names, for a series that has nothing better to be called. */
  nameByFileId: Record<string, string>
}

const EMPTY: DatasetRows = { byFileId: {}, nameByFileId: {} }

export function useDatasetRows(fileIds: readonly string[], enabled: boolean): DatasetRows {
  const files = useDatasetStore((s) => s.files)
  const loadFileData = useDatasetStore((s) => s.loadFileData)
  const getFileRows = useDatasetStore((s) => s.getFileRows)
  const dirtyVersion = useDatasetStore((s) => s._dirtyVersion)
  const [rows, setRows] = useState<Record<string, Record<string, unknown>[]>>({})

  // A stable key: the ids, plus what would make each dataset's rows differ. Without
  // the ops length an edit made in the Datasets page would never reach the chart.
  const signature = fileIds
    .map((id) => {
      const f = files.find((x) => x.id === id)
      return `${id}:${f?.rowCount ?? 0}:${(f?.ops ?? []).length}`
    })
    .join('|')

  useEffect(() => {
    if (!enabled || !signature) {
      setRows({})
      return
    }
    let cancelled = false
    const ids = signature.split('|').map((part) => part.slice(0, part.indexOf(':')))

    Promise.all(ids.map(async (id, i) => {
      if (isServerMode()) {
        const key = signature.split('|')[i]
        let pending = cache.get(key)
        if (!pending) {
          pending = queryDatasetRows(id, { offset: 0, limit: MAX_ROWS }).then((p) => p.rows)
          cache.set(key, pending)
        }
        try {
          return [id, await pending] as const
        } catch {
          cache.delete(key)
          return [id, []] as const
        }
      }
      await loadFileData(id)
      return [id, getFileRows(id)] as const
    })).then((entries) => {
      if (!cancelled) setRows(Object.fromEntries(entries))
    })

    return () => { cancelled = true }
    // `dirtyVersion` is a dep so an edit made in the Datasets page shows here.
  }, [enabled, signature, loadFileData, getFileRows, dirtyVersion])

  const nameByFileId = useMemo(() => {
    const out: Record<string, string> = {}
    for (const id of fileIds) out[id] = files.find((f) => f.id === id)?.name ?? ''
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, files])

  return useMemo(
    () => (enabled ? { byFileId: rows, nameByFileId } : EMPTY),
    [enabled, rows, nameByFileId],
  )
}
