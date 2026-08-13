import type { ConceptMapping, EffectiveMappingStatus, MappingProject, MappingStatus } from '@/types'

/** Build a stable key for a source concept (vocabulary + code).
 *  Used as the canonical dedup key across Progress, Mapping Editor, and Export. */
export function sourceKey(m: Pick<ConceptMapping, 'sourceVocabularyId' | 'sourceConceptCode'>): string {
  return `${m.sourceVocabularyId ?? ''}\0${m.sourceConceptCode ?? ''}`
}

/**
 * Total source concepts: the persisted stat when populated, else the file row
 * count for file-based projects.
 *
 * The fallback matters because an export empties `fileSourceData.rows` and keeps
 * only `totalRowCount` — reading `rows.length` alone yields 0 on every git-linked
 * project. A database project's total needs a DuckDB query, so it keeps whatever
 * was persisted and is refreshed when the project is opened.
 */
export function getTotalSourceConcepts(project: Pick<MappingProject, 'stats' | 'sourceType' | 'fileSourceData'>): number {
  const fromStats = project.stats?.totalSourceConcepts ?? 0
  if (fromStats > 0) return fromStats
  if (project.sourceType === 'file' && project.fileSourceData) {
    return project.fileSourceData.totalRowCount ?? project.fileSourceData.rows?.length ?? 0
  }
  return 0
}

/**
 * Whether a mapping is frozen against edits (changing its equivalence, deleting it).
 *
 * A mapping is locked once someone else has assessed it: any review, or a comment
 * from anyone other than its author. Editing it then would silently invalidate that
 * assessment.
 *
 * The author's own comments do NOT lock it — annotating your own work while you
 * refine it is part of making the mapping, not an assessment of it.
 *
 * Attribution must be provable on both sides: a comment with no `authorId`, or a
 * mapping with no `mappedBy`, locks as if it were someone else's. Treating an
 * unknown author as a match would unlock exactly the untraceable cases.
 */
export function isMappingLocked(m: Pick<ConceptMapping, 'reviews' | 'comments' | 'mappedBy'>): boolean {
  if ((m.reviews?.length ?? 0) > 0) return true
  const comments = m.comments ?? []
  if (comments.length === 0) return false
  if (!m.mappedBy) return true
  return comments.some((c) => c.authorId !== m.mappedBy)
}

/** Compute the effective status of a mapping based on review votes.
 *  - No reviews → fall back to the mapping's stored status.
 *  - Reviewers disagree (≥2 distinct non-unchecked statuses present) → 'disputed'.
 *  - Otherwise: the unique non-unchecked status used by reviewers. */
export function effectiveMappingStatus(m: ConceptMapping): EffectiveMappingStatus {
  const reviews = m.reviews ?? []
  if (reviews.length === 0) return m.status
  const counts: Record<MappingStatus, number> = {
    approved: 0, rejected: 0, flagged: 0, ignored: 0, unchecked: 0, invalid: 0, suggested: 0,
  }
  for (const r of reviews) counts[r.status] = (counts[r.status] ?? 0) + 1
  // Look at the decisive statuses only. 'unchecked' and 'suggested' are
  // pending states ("no opinion" / "awaiting validation"), not decisions.
  const decisive: MappingStatus[] = ['approved', 'rejected', 'flagged', 'ignored', 'invalid']
  const present = decisive.filter((s) => counts[s] > 0)
  if (present.length === 0) return m.status
  if (present.length > 1) return 'disputed'
  return present[0]
}
