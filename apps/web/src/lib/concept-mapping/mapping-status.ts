import type { ConceptMapping, EffectiveMappingStatus, MappingStatus } from '@/types'

/** Build a stable key for a source concept (vocabulary + code).
 *  Used as the canonical dedup key across Progress, Mapping Editor, and Export. */
export function sourceKey(m: Pick<ConceptMapping, 'sourceVocabularyId' | 'sourceConceptCode'>): string {
  return `${m.sourceVocabularyId ?? ''}\0${m.sourceConceptCode ?? ''}`
}

/** Compute the effective status of a mapping based on review votes.
 *  - No reviews → fall back to the mapping's stored status.
 *  - Reviewers disagree (≥2 distinct non-unchecked statuses present) → 'disputed'.
 *  - Otherwise: the unique non-unchecked status used by reviewers. */
export function effectiveMappingStatus(m: ConceptMapping): EffectiveMappingStatus {
  const reviews = m.reviews ?? []
  if (reviews.length === 0) return m.status
  const counts: Record<MappingStatus, number> = {
    approved: 0, rejected: 0, flagged: 0, ignored: 0, unchecked: 0, invalid: 0,
  }
  for (const r of reviews) counts[r.status] = (counts[r.status] ?? 0) + 1
  // Look at the decisive statuses only (ignore 'unchecked' which means "no opinion").
  const decisive: MappingStatus[] = ['approved', 'rejected', 'flagged', 'ignored', 'invalid']
  const present = decisive.filter((s) => counts[s] > 0)
  if (present.length === 0) return m.status
  if (present.length > 1) return 'disputed'
  return present[0]
}
