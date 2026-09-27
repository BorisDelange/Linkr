import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { ConceptMapping, ProjectBadge } from '@/types'
import {
  commentPatch, defaultEntityId, describeMapping, filterMappings, newMappingProjectPayload, planAssignment,
  pointerTo, rangeError, resolveBadges, reviewPatch, suggestRange, voteError,
} from './mapping-extra'
import { registerMappingExtraTools } from './tools-mapping-extra'

const ids = () => { let n = 0; return () => `id${++n}` }

const mapping = (over: Partial<ConceptMapping>): ConceptMapping => ({
  id: 'm1', projectId: 'p1', sourceConceptId: 0, sourceConceptName: 'Heart rate', sourceVocabularyId: 'REA',
  sourceDomainId: '', sourceConceptCode: 'HR', targetConceptId: 3027018, targetConceptName: 'Heart rate',
  targetVocabularyId: 'LOINC', targetDomainId: 'Measurement', targetConceptCode: '8867-4', equivalence: 'skos:exactMatch',
  status: 'unchecked', mappedBy: 'Ada Lovelace', createdAt: '', updatedAt: '', ...over,
})

describe('entity ids', () => {
  it('derives a free slug from the name', () => {
    expect(defaultEntityId('Réa Rennes', ['rea-rennes'])).toBe('rea-rennes-2')
  })
})

describe('resolveBadges', () => {
  const siblings: ProjectBadge[] = [{ id: 's', label: { en: 'Rennes', fr: 'Rennes' }, color: 'red' }]

  it('reuses a sibling badge colour and spelling, new ones are blue, duplicates dropped', () => {
    const out = resolveBadges(['rennes', 'Nantes', 'NANTES', ' '], siblings, ids())
    expect(out).toEqual([
      { id: 'id1', label: { en: 'Rennes', fr: 'Rennes' }, color: 'red' },
      { id: 'id2', label: { en: 'Nantes', fr: 'Nantes' }, color: 'blue' },
    ])
  })
})

describe('newMappingProjectPayload', () => {
  const base = {
    id: 'p', lineageId: 'l', workspaceId: 'w', entityId: 'e', name: ' ICU ', status: 'in_progress' as const,
    badges: [], version: '0.1.0', now: 'T',
  }

  it('writes a database project with portable pointers', () => {
    const p = newMappingProjectPayload({
      ...base, databaseId: 'db', vocabularyDatabaseId: 'voc',
      databases: [{ id: 'db', lineageId: 'L1', name: { en: 'MIMIC' } }, { id: 'voc', entityId: 'athena' }],
    })
    expect(p).toMatchObject({
      name: { en: 'ICU' }, sourceType: 'database', dataSourceId: 'db',
      dataSourceRef: { lineageId: 'L1', label: { en: 'MIMIC' } },
      vocabularyDataSourceId: 'voc', vocabularyDataSourceRef: { entityId: 'athena' }, conceptSetIds: [], lineageId: 'l',
    })
    expect(p).not.toHaveProperty('createdBy')
  })

  it('writes a sourceless file project when no database is given', () => {
    const p = newMappingProjectPayload({ ...base, databases: [] })
    expect(p).toMatchObject({ sourceType: 'file', dataSourceId: '' })
    expect(p).not.toHaveProperty('dataSourceRef')
    expect(p).not.toHaveProperty('fileSourceData')
  })

  it('has no pointer for a database without identity', () => {
    expect(pointerTo([{ id: 'x' }], 'x')).toBeUndefined()
  })
})

describe('reviews', () => {
  it('refuses approving or rejecting your own mapping, but allows a flag', () => {
    const m = mapping({})
    expect(voteError(m, 'Ada Lovelace', 'approved')).toMatch(/author/)
    expect(voteError(m, 'Ada Lovelace', 'flagged')).toBeNull()
    expect(voteError(m, 'Bob', 'rejected')).toBeNull()
  })

  it('replaces the reviewer vote keeping its id, and clears the bookkeeping on withdrawal', () => {
    const m = mapping({
      reviews: [
        { id: 'r1', reviewerId: 'Bob', status: 'flagged', createdAt: 'old' },
        { id: 'r2', reviewerId: 'Eve', status: 'approved', createdAt: 'old' },
      ],
    })
    const patch = reviewPatch(m, 'Bob', {}, 'approved', ' fine ', 'now', ids())
    expect(patch.reviews).toEqual([
      { id: 'r2', reviewerId: 'Eve', status: 'approved', createdAt: 'old' },
      { id: 'r1', reviewerId: 'Bob', reviewerDetails: {}, status: 'approved', comment: 'fine', createdAt: 'now' },
    ])
    expect(patch).toMatchObject({ reviewedBy: 'Bob', reviewedOn: 'now' })
    const cleared = reviewPatch(m, 'Bob', {}, 'clear', undefined, 'now', ids())
    expect(cleared.reviews).toHaveLength(1)
    expect(cleared).toMatchObject({ reviewedBy: null, reviewedOn: null, reviewedByDetails: null })
  })

  it('appends a signed comment', () => {
    const out = commentPatch(mapping({ comments: [{ id: 'c0', authorId: 'Ada', text: 'x', createdAt: '' }] }), 'Bob', {}, ' ok ', 'now', 'c1')
    expect(out.comments.map((c) => c.text)).toEqual(['x', 'ok'])
  })
})

describe('filterMappings', () => {
  const list = [
    mapping({ id: 'a' }),
    mapping({ id: 'b', sourceConceptCode: 'SBP', sourceConceptName: 'Systolic', reviews: [{ id: 'r', reviewerId: 'Bob', status: 'approved', createdAt: '' }] }),
    mapping({ id: 'c', sourceConceptCode: 'X', reviews: [
      { id: 'r', reviewerId: 'Bob', status: 'approved', createdAt: '' }, { id: 's', reviewerId: 'Eve', status: 'rejected', createdAt: '' },
    ] }),
  ]

  it('filters on the effective status, codes, words and the user\'s votes', () => {
    expect(filterMappings(list, { status: 'approved' }).map((m) => m.id)).toEqual(['b'])
    expect(filterMappings(list, { status: 'disputed' }).map((m) => m.id)).toEqual(['c'])
    expect(filterMappings(list, { conceptCodes: ['REA/SBP'] }).map((m) => m.id)).toEqual(['b'])
    expect(filterMappings(list, { search: 'systolic' }).map((m) => m.id)).toEqual(['b'])
    expect(filterMappings(list, { reviewedByMe: false, me: 'Bob' }).map((m) => m.id)).toEqual(['a'])
  })

  it('describes a mapping on one line with its lock', () => {
    expect(describeMapping(list[1])).toContain('b · approved · REA/SBP Systolic → 3027018 Heart rate [LOINC 8867-4]')
    expect(describeMapping(list[1])).toContain('locked')
  })
})

describe('source concept id ranges', () => {
  it('suggests the next million after the highest range', () => {
    expect(suggestRange([])).toEqual({ start: 2_000_000_000, end: 2_000_999_999 })
    expect(suggestRange([{ badgeLabel: 'A', rangeStart: 2_000_000_000, rangeEnd: 2_000_999_999 }]))
      .toEqual({ start: 2_001_000_000, end: 2_001_999_999 })
    expect(suggestRange([{ badgeLabel: 'A', rangeStart: 2_100_000_000, rangeEnd: 2_147_483_647 }])).toBeNull()
  })

  it('refuses bounds outside the band, reversed or overlapping another badge', () => {
    const ranges = [{ badgeLabel: 'A', rangeStart: 2_000_000_000, rangeEnd: 2_000_000_099 }]
    expect(rangeError(ranges, 'B', 1_999_999_999, 2_000_000_500)).toMatch(/start at/)
    expect(rangeError(ranges, 'B', 2_000_000_600, 2_000_000_500)).toMatch(/ends before/)
    expect(rangeError(ranges, 'B', 2_000_000_050, 2_000_000_500)).toMatch(/overlaps.*"A"/)
    expect(rangeError(ranges, 'A', 2_000_000_050, 2_000_000_500)).toBeNull()
    expect(rangeError(ranges, 'B', 2_000_000_100, 2_000_000_100)).toBeNull()
  })

  it('assigns new pairs from the cursor, skips existing and duplicates, stops at the end', () => {
    const range = { workspaceId: 'w', badgeLabel: 'A', rangeStart: 2_000_000_000, rangeEnd: 2_000_000_002, nextId: 2_000_000_000 }
    const plan = planAssignment({
      pairs: [['V', '1'], ['V', '2'], ['V', '1'], ['V', '3'], ['V', '4'], ['V', '']],
      existingKeys: new Set(['V\u00002']),
      range, highestOwnId: 2_000_000_000, now: 'T',
    })
    expect(plan.entries.map((e) => [e.conceptCode, e.sourceConceptId])).toEqual([['1', 2_000_000_001], ['3', 2_000_000_002]])
    expect(plan.entries[0].id).toBe('w__A__V__1')
    expect(plan.exhausted).toBe(true)
    expect(plan.nextId).toBe(2_000_000_003)
    expect(plan.total).toBe(4)
  })
})

describe('registerMappingExtraTools', () => {
  it('registers every tool with a valid schema', () => {
    expect(() => registerMappingExtraTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
