/**
 * Dataset series for the patient timeline — several datasets on one axis.
 *
 * The fetching lives in `useDatasetRows`; this only turns the rows into the shape
 * the timeline draws, once per configured mapping.
 */
import { useMemo } from 'react'
import {
  datasetRowsToTimeline,
  type DatasetTimelineMapping,
  type DatasetTimelineRow,
} from '@/lib/patient-data/dataset-timeline'
import { useDatasetRows } from './use-dataset-rows'

/** A mapping is only drawable once it names the patient and the date. */
export function isPlottable(
  mapping: Partial<DatasetTimelineMapping> | undefined,
): mapping is DatasetTimelineMapping {
  return !!(mapping?.datasetFileId && mapping.personColumn && mapping.dateColumn)
}

const NO_ROWS: DatasetTimelineRow[] = []

export function useDatasetSeries(
  mappings: readonly Partial<DatasetTimelineMapping>[] | undefined,
  personId: string | null,
  visitId: string | null,
  enabled: boolean,
  visitDetailId?: string | null,
): DatasetTimelineRow[] {
  const plottable = useMemo(
    () => (mappings ?? []).filter(isPlottable),
    [mappings],
  )
  // Stable across renders that don't change the set, so the fetch effect below
  // doesn't re-run on every parent render.
  const fileIds = useMemo(
    () => [...new Set(plottable.map((m) => m.datasetFileId))],
    [plottable],
  )
  const { byFileId, nameByFileId } = useDatasetRows(fileIds, enabled && fileIds.length > 0)

  return useMemo(() => {
    if (!enabled || plottable.length === 0) return NO_ROWS
    const out = plottable.flatMap((mapping) => datasetRowsToTimeline(
      byFileId[mapping.datasetFileId] ?? [],
      mapping,
      { personId, visitId, visitDetailId },
      nameByFileId[mapping.datasetFileId] ?? '',
    ))
    // Merged from several datasets, so re-sort: the timeline reshapes one ordered
    // list into series and each dataset was only sorted within itself.
    return out.sort((a, b) => Number(a.event_date) - Number(b.event_date))
  }, [enabled, plottable, byFileId, nameByFileId, personId, visitId, visitDetailId])
}
