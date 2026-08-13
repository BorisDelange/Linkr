import { describe, it, expect } from 'vitest'
import { getTotalSourceConcepts, isMappingLocked } from './mapping-status'
import type { MappingComment, MappingReview } from '@/types'

const comment = (authorId: string): MappingComment => ({
  id: `c-${authorId}`,
  authorId,
  text: 'note',
  createdAt: '2026-01-01T00:00:00.000Z',
})

const review = (): MappingReview => ({
  id: 'r-1',
  reviewerId: 'reviewer',
  status: 'approved',
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('isMappingLocked', () => {
  it('leaves an untouched mapping editable', () => {
    expect(isMappingLocked({ mappedBy: 'alice' })).toBe(false)
    expect(isMappingLocked({ mappedBy: 'alice', comments: [], reviews: [] })).toBe(false)
  })

  it('locks as soon as there is a review, whoever wrote it', () => {
    expect(isMappingLocked({ mappedBy: 'alice', reviews: [review()] })).toBe(true)
  })

  it('keeps the author free to annotate their own mapping', () => {
    expect(isMappingLocked({
      mappedBy: 'alice',
      comments: [comment('alice'), comment('alice')],
    })).toBe(false)
  })

  it('locks once someone else comments', () => {
    expect(isMappingLocked({ mappedBy: 'alice', comments: [comment('bob')] })).toBe(true)
  })

  it('locks when the author commented but someone else did too', () => {
    expect(isMappingLocked({
      mappedBy: 'alice',
      comments: [comment('alice'), comment('bob')],
    })).toBe(true)
  })

  it('locks when attribution cannot be proven on either side', () => {
    // Unattributed comment: no way to show it is the author's.
    expect(isMappingLocked({ mappedBy: 'alice', comments: [comment('')] })).toBe(true)
    // Unknown mapper: every comment is someone else's as far as we can tell.
    expect(isMappingLocked({ comments: [comment('alice')] })).toBe(true)
  })

  it('still locks an unattributed mapping through its reviews', () => {
    expect(isMappingLocked({ reviews: [review()] })).toBe(true)
  })
})

describe('getTotalSourceConcepts', () => {
  const fileProject = (fileSourceData: Record<string, unknown>, stats?: Record<string, unknown>) =>
    ({ sourceType: 'file', fileSourceData, stats } as unknown as Parameters<typeof getTotalSourceConcepts>[0])

  it('prefers the persisted stat when it is populated', () => {
    expect(getTotalSourceConcepts(fileProject({ totalRowCount: 10, rows: [] }, { totalSourceConcepts: 9912 }))).toBe(9912)
  })

  it('falls back to totalRowCount when the project carries no stats', () => {
    // The pull/import case: stats are not in the store yet, and an export has
    // emptied `rows` — reading rows.length alone would persist a permanent 0.
    expect(getTotalSourceConcepts(fileProject({ totalRowCount: 9912, rows: [] }))).toBe(9912)
    expect(getTotalSourceConcepts(fileProject({ totalRowCount: 9912, rows: [] }, { totalSourceConcepts: 0 }))).toBe(9912)
  })

  it('falls back to the in-memory rows when there is no totalRowCount', () => {
    expect(getTotalSourceConcepts(fileProject({ rows: [{}, {}, {}] }))).toBe(3)
  })

  it('returns 0 for a database project with no stat, leaving it to the DuckDB query', () => {
    expect(getTotalSourceConcepts({ sourceType: 'database' } as unknown as Parameters<typeof getTotalSourceConcepts>[0])).toBe(0)
  })
})
