/**
 * Comparing what a pipeline mapped against what it actually loaded.
 *
 * Both counts come from the TARGET database: the `*_source_concept_id` columns
 * say how many rows arrived carrying a source concept, and the `*_concept_id`
 * columns how many were mapped to a standard one. A row that came in but did not
 * map is the defect this view exists to surface.
 */

/** One mapped concept, with the counts observed on each side. */
export interface QualityConceptRow {
  sourceVocabularyId: string
  sourceCode: string
  sourceDescription: string
  sourceConceptId: number
  targetConceptId: number
  targetVocabularyId: string
  sourcePatients: number
  sourceRows: number
  targetPatients: number
  targetRows: number
  diff: QualityDiff
}

export type QualityDiff = 'match' | 'fewer' | 'more' | 'missing'

export interface ConceptCount {
  patients: number
  rows: number
}

/**
 * Verdict for one mapping.
 *
 * `expectedRows` is the source total for the TARGET concept, not for this row: an
 * N:1 mapping sends several source codes to one target, so each row's own count
 * would look short against the target's combined total.
 */
export function classifyDiff(
  sourceRows: number,
  targetRows: number,
  expectedRows: number,
): QualityDiff {
  // Rows arrived but none mapped — the mapping did not take effect at all.
  if (sourceRows > 0 && targetRows === 0) return 'missing'
  if (expectedRows > 0 && targetRows < expectedRows) return 'fewer'
  if (expectedRows > 0 && targetRows > expectedRows) return 'more'
  return 'match'
}

/**
 * Source rows expected per target concept, summed over the mappings that feed it.
 * Keyed by target_concept_id.
 */
export function expectedRowsByTarget(
  mappings: { sourceConceptId: number; targetConceptId: number }[],
  sourceCounts: Map<number, ConceptCount>,
): Map<number, number> {
  const totals = new Map<number, number>()
  for (const m of mappings) {
    const rows = m.sourceConceptId > 0 ? (sourceCounts.get(m.sourceConceptId)?.rows ?? 0) : 0
    totals.set(m.targetConceptId, (totals.get(m.targetConceptId) ?? 0) + rows)
  }
  return totals
}

/** How many rows fall in each verdict, for the filter chips. */
export function countByDiff(rows: { diff: QualityDiff }[]): Record<QualityDiff, number> {
  const counts: Record<QualityDiff, number> = { missing: 0, fewer: 0, more: 0, match: 0 }
  for (const r of rows) counts[r.diff]++
  return counts
}

/** OMOP clinical tables and the concept column to count, per side. */
export const CLINICAL_TABLES = [
  { table: 'condition_occurrence', standard: 'condition_concept_id', source: 'condition_source_concept_id' },
  { table: 'drug_exposure', standard: 'drug_concept_id', source: 'drug_source_concept_id' },
  { table: 'measurement', standard: 'measurement_concept_id', source: 'measurement_source_concept_id' },
  { table: 'procedure_occurrence', standard: 'procedure_concept_id', source: 'procedure_source_concept_id' },
  { table: 'observation', standard: 'observation_concept_id', source: 'observation_source_concept_id' },
  { table: 'device_exposure', standard: 'device_concept_id', source: 'device_source_concept_id' },
  { table: 'specimen', standard: 'specimen_concept_id', source: 'specimen_source_concept_id' },
] as const
