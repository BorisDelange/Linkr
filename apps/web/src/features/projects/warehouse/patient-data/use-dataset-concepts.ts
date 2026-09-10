/**
 * The dataset series a widget can plot, as concept rows.
 *
 * Shaped as `ConceptRow` so the Concepts page's own table lists them beside the
 * warehouse's concepts: a dataset series answers the same questions a concept does
 * — what is it, how many rows, how many patients — plus which dataset it came from,
 * which the warehouse never needs to say because there is only ever one.
 */
import { useMemo } from 'react'
import {
  datasetSeriesKeyId,
  datasetSeriesOptions,
  groupsByCode,
  type DatasetTimelineMapping,
} from '@/lib/patient-data/dataset-timeline'
import { useDatasetStore } from '@/stores/dataset-store'
import { useDatasetRows } from './widgets/use-dataset-rows'
import type { ConceptRow } from '../concepts/use-concepts'

/** A series' own row, carrying the dataset it belongs to. */
export interface DatasetConceptRow extends ConceptRow {
  /** Dataset file id — which mapping's `codes` this row belongs to. */
  _dataset_id: string
  /** Dataset name, shown in the Source column and the selected panel's tooltip. */
  _source: string
  /** The code (or label) stored in that mapping's `codes`. */
  _code: string
}

/** A mapping is only listable once it names the patient and the date. */
function ready(m: Partial<DatasetTimelineMapping>): m is DatasetTimelineMapping {
  return !!(m.datasetFileId && m.personColumn && m.dateColumn)
}

export function useDatasetConcepts(
  mappings: readonly Partial<DatasetTimelineMapping>[],
  enabled: boolean,
): { rows: DatasetConceptRow[]; loading: boolean } {
  const files = useDatasetStore((s) => s.files)

  const usable = useMemo(() => mappings.filter(ready), [mappings])
  const fileIds = useMemo(
    () => [...new Set(usable.map((m) => m.datasetFileId))],
    [usable],
  )
  const { byFileId } = useDatasetRows(fileIds, enabled && fileIds.length > 0)

  const rows = useMemo(() => {
    if (!enabled) return []
    const out: DatasetConceptRow[] = []
    for (const mapping of usable) {
      const rows = byFileId[mapping.datasetFileId]
      if (!rows) continue
      const name = files.find((f) => f.id === mapping.datasetFileId)?.name ?? ''
      // A dataset with neither a code nor a label column is ONE series covering
      // every row, so it has nothing to choose between — listing it as a single
      // pickable row would suggest a filter that does not exist.
      if (!groupsByCode(mapping)) continue
      for (const option of datasetSeriesOptions(rows, mapping)) {
        out.push({
          concept_id: datasetSeriesKeyId(mapping.datasetFileId, option.code),
          concept_name: option.name,
          concept_code: option.code,
          record_count: option.recordCount,
          patient_count: option.patientCount,
          _dataset_id: mapping.datasetFileId,
          _source: name,
          _code: option.code,
        })
      }
    }
    return out
  }, [enabled, usable, byFileId, files])

  // Every usable dataset must have landed; a partial list would look complete.
  const loading = enabled && fileIds.some((id) => !byFileId[id])

  return { rows, loading }
}
