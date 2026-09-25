import { describe, expect, it } from 'vitest'
import { auditQueryParams } from './audit-log'

describe('auditQueryParams', () => {
  it('turns a page into limit/offset', () => {
    const p = auditQueryParams({ page: 2, pageSize: 100, sorting: null, filters: {} })
    expect(p.get('limit')).toBe('100')
    expect(p.get('offset')).toBe('200')
    expect(p.has('sort')).toBe(false)
    expect(p.has('filters')).toBe(false)
  })

  it('carries the sort and the active filters', () => {
    const p = auditQueryParams({
      page: 0, pageSize: 50,
      sorting: { columnId: 'at', desc: false },
      filters: { username: ['bob'], summary: 'person' },
    })
    expect(p.get('sort')).toBe('at')
    expect(p.get('desc')).toBe('false')
    expect(JSON.parse(p.get('filters')!)).toEqual({ username: ['bob'], summary: 'person' })
  })

  it('omits paging for an export', () => {
    const p = auditQueryParams({ sorting: null, filters: { what: ['query'] } })
    expect(p.has('limit')).toBe(false)
    expect(p.get('filters')).toBe('{"what":["query"]}')
  })
})
