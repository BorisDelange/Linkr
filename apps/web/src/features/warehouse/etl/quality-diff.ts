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
  /**
   * Source rows expected for this row's TARGET concept, summed over every mapping
   * that feeds it. This — not `sourceRows` — is what the verdict compares against,
   * so it has to be visible: on an N:1 mapping the row's own count differs from it
   * and an "OK" beside two unequal numbers looks like a bug.
   */
  expectedRows: number
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

/**
 * Fingerprint of the inputs the concept table is derived from.
 *
 * The counts change when the ETL runs and at no other time, so the last
 * completed run identifies the state of the data. A cache whose fingerprint no
 * longer matches is stale and must not be served: showing yesterday's counts
 * beside today's target would defeat the point of the check.
 *
 * `none` when the pipeline has never run — a hand-loaded target still gets a
 * cache, just one that only the Refresh button invalidates.
 */
export function qualityFingerprint(
  runs: readonly { status: string; completedAt?: string; startedAt: string }[],
): string {
  const done = runs.filter((r) => r.status !== 'running' && r.completedAt)
  if (done.length === 0) return 'none'
  // Max, not "last in the array": run history order is not guaranteed, and a
  // re-sorted list must not read as a different fingerprint.
  return done.reduce((best, r) => (r.completedAt! > best ? r.completedAt! : best), '')
}

/**
 * Can this cached table be shown?
 *
 * Both the target database and the fingerprint must match. The target matters
 * because the rows are counts read FROM it: a pipeline repointed at another
 * database would otherwise display the previous one's figures.
 */
export function isQualityCacheUsable(
  cache: { targetDataSourceId?: string; fingerprint?: string } | undefined,
  targetDataSourceId: string | undefined,
  fingerprint: string,
): boolean {
  if (!cache || !targetDataSourceId) return false
  return cache.targetDataSourceId === targetDataSourceId && cache.fingerprint === fingerprint
}

export type TableSortKey = 'name' | 'rows'

export interface TableSort {
  by: TableSortKey
  desc: boolean
}

/**
 * Search + sort the per-table row counts of the Statistics view.
 *
 * Names are compared with `localeCompare` so accents and case sort the way the
 * user reads them, and ties on the count fall back to the name — otherwise the
 * many empty tables of a partly-filled OMOP target come out in an arbitrary
 * order that changes between renders.
 */
export function sortTableCounts<T extends { tableName: string; rowCount: number }>(
  counts: readonly T[],
  search: string,
  sort: TableSort,
): T[] {
  const needle = search.trim().toLowerCase()
  const out = needle
    ? counts.filter((c) => c.tableName.toLowerCase().includes(needle))
    : [...counts]
  const byName = (a: T, b: T) => a.tableName.localeCompare(b.tableName)
  out.sort((a, b) => {
    if (sort.by === 'name') return sort.desc ? byName(b, a) : byName(a, b)
    const delta = a.rowCount - b.rowCount
    if (delta !== 0) return sort.desc ? -delta : delta
    return byName(a, b)
  })
  return out
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
