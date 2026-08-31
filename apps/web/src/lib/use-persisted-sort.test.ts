import { describe, it, expect, vi } from 'vitest'

// The store reads localStorage at import time, which the node test env lacks.
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(() => undefined, { getState: () => ({ setPreference: () => {} }) }),
}))

import { parseStoredSort } from './use-persisted-sort'

describe('parseStoredSort', () => {
  it('accepts a well-formed sort state on a known field', () => {
    expect(parseStoredSort({ key: 'name', dir: 'asc' })).toEqual({ key: 'name', dir: 'asc' })
    expect(parseStoredSort({ key: 'lastVisit', dir: 'desc' })).toEqual({ key: 'lastVisit', dir: 'desc' })
  })

  it('rejects an unknown sort field, so a stale preference cannot leave a list unsorted', () => {
    expect(parseStoredSort({ key: 'removedField', dir: 'asc' })).toBeNull()
  })

  it('rejects a malformed direction', () => {
    expect(parseStoredSort({ key: 'name', dir: 'sideways' })).toBeNull()
    expect(parseStoredSort({ key: 'name' })).toBeNull()
  })

  it('rejects non-object values', () => {
    for (const value of [null, undefined, 'name', 42, []]) {
      expect(parseStoredSort(value)).toBeNull()
    }
  })

  it('drops extra keys rather than passing them through', () => {
    expect(parseStoredSort({ key: 'created', dir: 'asc', rogue: 1 })).toEqual({ key: 'created', dir: 'asc' })
  })
})
