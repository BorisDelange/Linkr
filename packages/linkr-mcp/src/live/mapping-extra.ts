/** Pure helpers for the mapping-project lifecycle, reviews and source concept id ranges. */
import type {
  AuthorDetails, ConceptMapping, MappingComment, MappingProject, MappingProjectStatus, MappingReview, MappingStatus,
  ProjectBadge, SourceConceptIdEntry, SourceConceptIdRange,
} from '@/types'
import { effectiveMappingStatus, isMappingLocked } from '@/lib/concept-mapping/mapping-status'
import { sourceConceptPairKey } from '@/lib/concept-mapping/source-concept-ids-io'
import { OMOP_CUSTOM_MAX, OMOP_CUSTOM_MIN, clampNextId } from '@/features/warehouse/concept-mapping/source-id-range'
import { localized, setLocalized } from '@/lib/localized'
import { slugifyId, uniqueEntityId } from '@/lib/slugify-id'

export const PROJECT_STATUSES: MappingProjectStatus[] = ['in_progress', 'on_hold', 'completed']
export type Vote = 'approved' | 'rejected' | 'flagged' | 'clear'

export const defaultEntityId = (name: string, taken: string[]) => uniqueEntityId(slugifyId(name), taken)

/**
 * Badges from labels, as the app's badge editor adds them: a label a sibling
 * project already carries is reused with its colour and translations (a badge
 * keys its source concept id range by its English label, so the spelling must
 * match), anything else is a new blue badge.
 */
export function resolveBadges(labels: string[], siblings: ProjectBadge[], newId: () => string): ProjectBadge[] {
  const byLabel = new Map<string, ProjectBadge>()
  for (const b of siblings) {
    const key = localized(b.label, 'en').trim().toLowerCase()
    if (key && !byLabel.has(key)) byLabel.set(key, b)
  }
  const out: ProjectBadge[] = []
  const seen = new Set<string>()
  for (const raw of labels) {
    const text = raw.trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    const sibling = byLabel.get(key)
    out.push(sibling
      ? { id: newId(), label: setLocalized(sibling.label, 'en', localized(sibling.label, 'en').trim()), color: sibling.color }
      : { id: newId(), label: setLocalized(text, 'en', text), color: 'blue' })
  }
  return out
}

export interface PointerRow { id: string; entityId?: string | null; lineageId?: string | null; name?: unknown }

/** Mirrors `buildPointer`: the portable form of a database reference. */
export function pointerTo(rows: PointerRow[], id: string | undefined) {
  if (!id) return undefined
  const row = rows.find((r) => r.id === id)
  if (!row || (!row.lineageId && !row.entityId)) return undefined
  return {
    ...(row.lineageId ? { lineageId: row.lineageId } : {}),
    ...(row.entityId ? { entityId: row.entityId } : {}),
    ...(row.name !== undefined ? { label: row.name } : {}),
  }
}

/** The project row the app's create dialog writes; the server stamps the creator. */
export function newMappingProjectPayload(args: {
  id: string
  lineageId: string
  workspaceId: string
  entityId: string
  name: string
  description?: string
  status: MappingProjectStatus
  badges: ProjectBadge[]
  version: string
  databaseId?: string
  vocabularyDatabaseId?: string
  databases: PointerRow[]
  now: string
}): Record<string, unknown> {
  const dataSourceRef = pointerTo(args.databases, args.databaseId)
  const vocabularyRef = pointerTo(args.databases, args.vocabularyDatabaseId)
  return {
    id: args.id,
    entityId: args.entityId,
    workspaceId: args.workspaceId,
    name: setLocalized(undefined, 'en', args.name.trim()),
    description: setLocalized(undefined, 'en', (args.description ?? '').trim()),
    status: args.status,
    badges: args.badges,
    // The dialog's default kind: a project without a database is a file project
    // awaiting its file.
    sourceType: args.databaseId ? 'database' : 'file',
    dataSourceId: args.databaseId ?? '',
    ...(dataSourceRef ? { dataSourceRef } : {}),
    ...(args.vocabularyDatabaseId ? { vocabularyDataSourceId: args.vocabularyDatabaseId } : {}),
    ...(vocabularyRef ? { vocabularyDataSourceRef: vocabularyRef } : {}),
    conceptSetIds: [],
    version: args.version,
    lineageId: args.lineageId,
    createdAt: args.now,
    updatedAt: args.now,
  }
}

/** Why a vote cannot be cast, or null. Approving or rejecting one's own mapping is refused, as in the app. */
export function voteError(m: Pick<ConceptMapping, 'mappedBy'>, reviewer: string, vote: Vote): string | null {
  if ((vote === 'approved' || vote === 'rejected') && m.mappedBy === reviewer) {
    return `it was mapped by ${reviewer} (you); a mapping cannot be approved or rejected by its author — flag it instead.`
  }
  return null
}

/**
 * The reviewer's vote replaced (or withdrawn), with the review bookkeeping the
 * app writes beside it. One vote per reviewer, keyed by display name.
 */
export function reviewPatch(
  m: Pick<ConceptMapping, 'reviews'>,
  reviewer: string,
  details: AuthorDetails,
  vote: Vote,
  comment: string | undefined,
  now: string,
  newId: () => string,
): Record<string, unknown> {
  const reviews = m.reviews ?? []
  const mine = reviews.find((r) => r.reviewerId === reviewer)
  const next: MappingReview[] = [
    ...reviews.filter((r) => r.reviewerId !== reviewer),
    ...(vote !== 'clear' ? [{
      id: mine?.id ?? newId(),
      reviewerId: reviewer,
      reviewerDetails: details,
      status: vote as MappingStatus,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
      createdAt: now,
    }] : []),
  ]
  // null, not undefined: a withdrawn vote must clear the fields server-side.
  return vote !== 'clear'
    ? { reviews: next, reviewedBy: reviewer, reviewedByDetails: details, reviewedOn: now }
    : { reviews: next, reviewedBy: null, reviewedByDetails: null, reviewedOn: null }
}

export function commentPatch(
  m: Pick<ConceptMapping, 'comments'>, author: string, details: AuthorDetails, textBody: string, now: string, id: string,
): { comments: MappingComment[] } {
  return { comments: [...(m.comments ?? []), { id, authorId: author, authorDetails: details, text: textBody.trim(), createdAt: now }] }
}

export interface MappingFilters {
  status?: string
  search?: string
  conceptCodes?: string[]
  targetConceptId?: number
  equivalence?: string
  mappedBy?: string
  category?: string
  reviewedByMe?: boolean | null
  me?: string
}

export function filterMappings(mappings: ConceptMapping[], f: MappingFilters): ConceptMapping[] {
  const words = (f.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const codes = f.conceptCodes?.length ? new Set(f.conceptCodes) : null
  return mappings.filter((m) => {
    if (f.status && f.status !== 'all' && effectiveMappingStatus(m) !== f.status) return false
    if (codes && !codes.has(m.sourceConceptCode) && !codes.has(`${m.sourceVocabularyId}/${m.sourceConceptCode}`)) return false
    if (f.targetConceptId !== undefined && m.targetConceptId !== f.targetConceptId) return false
    if (f.equivalence && m.equivalence !== f.equivalence) return false
    if (f.mappedBy && (m.mappedBy ?? '').toLowerCase() !== f.mappedBy.toLowerCase()) return false
    if (f.category && m.sourceCategoryId !== f.category) return false
    if (f.reviewedByMe != null && f.me) {
      const mine = (m.reviews ?? []).some((r) => r.reviewerId === f.me)
      if (mine !== f.reviewedByMe) return false
    }
    if (words.length) {
      const hay = `${m.sourceConceptName} ${m.sourceConceptCode} ${m.targetConceptName} ${m.targetConceptCode}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) return false
    }
    return true
  })
}

export function describeMapping(m: ConceptMapping): string {
  const target = m.targetConceptId
    ? `${m.targetConceptId} ${m.targetConceptName} [${m.targetVocabularyId}${m.targetConceptCode ? ` ${m.targetConceptCode}` : ''}]`
    : '(no target)'
  const votes = (m.reviews ?? []).map((r) => `${r.reviewerId}: ${r.status}`).join(', ')
  const extra = [
    m.equivalence,
    m.mappedBy ? `by ${m.mappedBy}` : null,
    votes ? `votes ${votes}` : null,
    m.comments?.length ? `${m.comments.length} comment(s)` : null,
    isMappingLocked(m) ? 'locked' : null,
  ].filter(Boolean).join(' · ')
  return `- ${m.id} · ${effectiveMappingStatus(m)} · ${m.sourceVocabularyId ? `${m.sourceVocabularyId}/` : ''}${m.sourceConceptCode} `
    + `${m.sourceConceptName} → ${target} · ${extra}`
}

// --- Source concept id ranges ------------------------------------------------

export const DEFAULT_RANGE_SIZE = 1_000_000

export type RangeBounds = Pick<SourceConceptIdRange, 'badgeLabel' | 'rangeStart' | 'rangeEnd'>

/** The app's "add a badge" default: the next million ids after the highest range. */
export function suggestRange(ranges: RangeBounds[]): { start: number; end: number } | null {
  const start = ranges.length === 0 ? OMOP_CUSTOM_MIN : Math.max(...ranges.map((r) => r.rangeEnd)) + 1
  if (start > OMOP_CUSTOM_MAX) return null
  return { start, end: Math.min(start + DEFAULT_RANGE_SIZE - 1, OMOP_CUSTOM_MAX) }
}

export function rangeError(ranges: RangeBounds[], badgeLabel: string, start: number, end: number): string | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'Bounds must be integers.'
  if (start < OMOP_CUSTOM_MIN) return `The range must start at ${OMOP_CUSTOM_MIN} or above (OMOP's local concept band).`
  if (end > OMOP_CUSTOM_MAX) return `The range must end at ${OMOP_CUSTOM_MAX} or below.`
  if (end < start) return 'The range ends before it starts.'
  const other = ranges.find((r) => r.badgeLabel !== badgeLabel && start <= r.rangeEnd && end >= r.rangeStart)
  if (other) return `The range overlaps the one of badge "${other.badgeLabel}" (${other.rangeStart}–${other.rangeEnd}).`
  return null
}

/**
 * The ids the app's Assign button would hand out: one per (vocabulary, code) of
 * the badge not yet in its registry, from the range's cursor, stopping at the
 * range's end. An id belongs to one badge only, so another badge's entries
 * never count as assigned here.
 */
export function planAssignment(args: {
  pairs: Iterable<[string, string]>
  existingKeys: Set<string>
  range: Pick<SourceConceptIdRange, 'workspaceId' | 'badgeLabel' | 'rangeStart' | 'rangeEnd' | 'nextId'>
  highestOwnId: number | null
  now: string
}): { entries: SourceConceptIdEntry[]; nextId: number; exhausted: boolean; total: number } {
  const { range } = args
  let nextId = clampNextId(range.nextId, range.rangeStart, range.rangeEnd, args.highestOwnId)
  const entries: SourceConceptIdEntry[] = []
  const unique = new Map<string, [string, string]>()
  for (const [vocab, code] of args.pairs) {
    if (code) unique.set(sourceConceptPairKey(vocab, code), [vocab, code])
  }
  let exhausted = false
  for (const [key, [vocabularyId, conceptCode]] of unique) {
    if (args.existingKeys.has(key)) continue
    if (nextId > range.rangeEnd) { exhausted = true; break }
    entries.push({
      id: `${range.workspaceId}__${range.badgeLabel}__${vocabularyId}__${conceptCode}`,
      workspaceId: range.workspaceId,
      badgeLabel: range.badgeLabel,
      vocabularyId,
      conceptCode,
      sourceConceptId: nextId++,
      createdAt: args.now,
    })
  }
  return { entries, nextId, exhausted, total: unique.size }
}

/** English badge labels of a workspace's projects — the keys ranges are stored under. */
export function badgeLabelsOf(projects: Pick<MappingProject, 'badges'>[]): string[] {
  const labels = new Set<string>()
  for (const p of projects) for (const b of p.badges ?? []) {
    const label = localized(b.label, 'en')
    if (label) labels.add(label)
  }
  return [...labels].sort()
}
