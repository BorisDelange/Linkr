import { describe, expect, it } from 'vitest'
import { readWikiPageMeta } from './wiki-page-meta'

describe('readWikiPageMeta', () => {
  it('reads a legacy verified page as approved, keeping its date', () => {
    const meta = readWikiPageMeta({ id: 'p', verified: true, verifiedAt: '2026-01-01' } as never)
    expect(meta).toEqual({ id: 'p', status: 'approved', statusChangedAt: '2026-01-01' })
  })

  it('drops a legacy unverified flag without inventing a status', () => {
    expect(readWikiPageMeta({ id: 'p', verified: false, verifiedAt: null } as never)).toEqual({ id: 'p' })
  })

  it('keeps an explicit status', () => {
    expect(readWikiPageMeta({ id: 'p', status: 'needs_revision' })).toEqual({ id: 'p', status: 'needs_revision' })
  })
})
