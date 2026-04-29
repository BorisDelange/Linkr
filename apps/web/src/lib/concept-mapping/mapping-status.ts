import type { ConceptMapping, MappingStatus } from '@/types'

/** Build a stable key for a source concept (vocabulary + code).
 *  Used as the canonical dedup key across Progress, Mapping Editor, and Export. */
export function sourceKey(m: Pick<ConceptMapping, 'sourceVocabularyId' | 'sourceConceptCode'>): string {
  return `${m.sourceVocabularyId ?? ''}\0${m.sourceConceptCode ?? ''}`
}

/** Compute the effective status of a mapping based on review votes.
 *  - No reviews → fall back to the mapping's stored status.
 *  - Otherwise: pick the status with the highest review count (priority: approved > rejected > flagged). */
export function effectiveMappingStatus(m: ConceptMapping): MappingStatus {
  const reviews = m.reviews ?? []
  if (reviews.length === 0) return m.status
  const counts: Record<MappingStatus, number> = {
    approved: 0, rejected: 0, flagged: 0, ignored: 0, unchecked: 0, invalid: 0,
  }
  for (const r of reviews) counts[r.status] = (counts[r.status] ?? 0) + 1
  const max = Math.max(...Object.values(counts))
  if (counts.approved === max) return 'approved'
  if (counts.rejected === max) return 'rejected'
  if (counts.flagged === max) return 'flagged'
  return m.status
}
