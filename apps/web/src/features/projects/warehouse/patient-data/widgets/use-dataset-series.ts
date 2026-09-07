/**
 * Dataset rows for the patient timeline.
 *
 * Front-only holds the dataset in memory; server mode pages it from the Parquet
 * cache. Either way the rows are filtered down to the selected patient here rather
 * than in SQL: a dataset has no schema mapping, so the patient column is whatever
 * the widget's config says it is, and the volumes involved (a hand-collected
 * table) are small enough that fetching once and filtering is simpler than
 * building a query per widget.
 */
import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { queryDatasetRows } from '@/lib/api/datasets'
import { useDatasetStore } from '@/stores/dataset-store'
import {
  datasetRowsToTimeline,
  type DatasetTimelineMapping,
  type DatasetTimelineRow,
} from '@/lib/patient-data/dataset-timeline'

/** Rows fetched per dataset in server mode, so N widgets on one dataset fetch once. */
const cache = new Map<string, Promise<Record<string, unknown>[]>>()

/** A hand-collected table is small; this bounds a misconfiguration, not real data. */
const MAX_ROWS = 50_000

export function useDatasetSeries(
  mapping: Partial<DatasetTimelineMapping> | undefined,
  personId: string | null,
  visitId: string | null,
  enabled: boolean,
): DatasetTimelineRow[] {
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const fileId = mapping?.datasetFileId
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const loadFileData = useDatasetStore((s) => s.loadFileData)
  const getFileRows = useDatasetStore((s) => s.getFileRows)
  const dirtyVersion = useDatasetStore((s) => s._dirtyVersion)

  useEffect(() => {
    if (!enabled || !fileId) {
      setRows([])
      return
    }
    let cancelled = false

    if (isServerMode()) {
      const key = `${fileId}:${file?.rowCount ?? 0}:${(file?.ops ?? []).length}`
      let pending = cache.get(key)
      if (!pending) {
        pending = queryDatasetRows(fileId, { offset: 0, limit: MAX_ROWS }).then((p) => p.rows)
        cache.set(key, pending)
      }
      pending
        .then((r) => { if (!cancelled) setRows(r) })
        .catch(() => {
          cache.delete(key)
          if (!cancelled) setRows([])
        })
      return () => { cancelled = true }
    }

    void loadFileData(fileId).then(() => {
      if (!cancelled) setRows(getFileRows(fileId))
    })
    return () => { cancelled = true }
    // `dirtyVersion` is a dep so an edit made in the Datasets page shows here.
  }, [enabled, fileId, file?.rowCount, file?.ops, loadFileData, getFileRows, dirtyVersion])

  if (!enabled || !mapping?.personColumn || !mapping.dateColumn) return []
  return datasetRowsToTimeline(
    rows,
    mapping as DatasetTimelineMapping,
    { personId, visitId },
    file?.name ?? '',
  )
}
