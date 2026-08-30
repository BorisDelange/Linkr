import type { ConceptMapping, EffectiveMappingStatus, MappingProject, MappingStatus } from '@/types'

/** Build a stable key for a source concept (vocabulary + code).
 *  Used as the canonical dedup key across Progress, Mapping Editor, and Export. */
export function sourceKey(m: Pick<ConceptMapping, 'sourceVocabularyId' | 'sourceConceptCode'>): string {
  return `${m.sourceVocabularyId ?? ''}\0${m.sourceConceptCode ?? ''}`
}

/**
 * Whether a project's source concepts are read from a flat table rather than
 * queried from a clinical database.
 *
 * True for an imported file, and equally for a database project whose Source
 * concepts tab has extracted its dictionary: the extraction writes the same
 * `fileSourceData`, so from that point the two are read by one code path. Ask
 * this rather than testing `sourceType === 'file'`, which answers where the
 * concepts originally came from — a different question, and the wrong one for
 * deciding how to read them.
 */
export function readsFromFlatSource(
  project: Pick<MappingProject, 'sourceType' | 'fileSourceData'>,
): boolean {
  return project.sourceType === 'file' || !!project.fileSourceData
}

/**
 * Whether a project's native source concept id is a real OMOP concept id.
 *
 * Only an imported file whose author mapped a column of OMOP concept ids gives
 * one. A database project's native id is that database's own key — a MIMIC
 * `d_items.itemid`, say — which is meaningful locally and nowhere else; the
 * extraction copies it into `concept_id`, so the presence of a `conceptIdColumn`
 * says nothing on its own. A file with no such column carries an artificial
 * row-number index. In both of those cases the badge registry is authoritative.
 */
export function hasNativeOmopConceptId(
  project: Pick<MappingProject, 'sourceType' | 'fileSourceData'>,
): boolean {
  return project.sourceType === 'file' && !!project.fileSourceData?.columnMapping?.conceptIdColumn
}

/**
 * The source concept id to display: the id assigned from a workspace badge when
 * one exists, else the project's native id.
 *
 * The registry wins because an assigned id is always a valid custom OMOP id in
 * the badge's band, and it is what identifies the originating site once rows
 * from several centres land in one warehouse. A native id is preferred only
 * where it is genuinely an OMOP concept id.
 */
export function resolveDisplayedSourceConceptId(
  project: Pick<MappingProject, 'sourceType' | 'fileSourceData'>,
  registry: Map<string, number> | undefined,
  vocabularyId: string | null | undefined,
  conceptCode: string | null | undefined,
  nativeId: number | null | undefined,
): number | null {
  const assigned = registry?.get(`${vocabularyId ?? ''}__${conceptCode ?? ''}`) ?? null
  if (assigned != null) return assigned
  if (hasNativeOmopConceptId(project) && nativeId != null && nativeId !== 0) return nativeId
  // No assignment yet: showing the native id is still better than a dash, since
  // it is what the Source concepts tab shows and what the code column echoes.
  return nativeId != null && nativeId !== 0 ? nativeId : null
}

/**
 * Total source concepts: the persisted stat when populated, else the row count
 * of the flat source.
 *
 * The fallback matters because an export empties `fileSourceData.rows` and keeps
 * only `totalRowCount` — reading `rows.length` alone yields 0 on every git-linked
 * project. A database project with nothing extracted yet has neither, so it
 * keeps whatever was persisted and is refreshed when the project is opened.
 */
export function getTotalSourceConcepts(
  project: Pick<MappingProject, 'stats' | 'sourceType' | 'fileSourceData' | 'sourceExtraction'>,
): number {
  // An extraction counts what it wrote, concept by concept, and is the one
  // number that cannot go stale: `totalRowCount` is re-derived asynchronously
  // after each save and a late reply can overwrite a newer one. Only trusted
  // once the run has finished, since mid-run it describes a partial file.
  const extraction = project.sourceExtraction
  if (extraction && extraction.total > 0 && extraction.extracted >= extraction.total) {
    return extraction.extracted
  }
  const fromStats = project.stats?.totalSourceConcepts ?? 0
  if (fromStats > 0) return fromStats
  if (readsFromFlatSource(project) && project.fileSourceData) {
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
