import { describe, it, expect } from 'vitest'
import { deterministicId } from './deterministic-id'

// Import remapping derives new ids from (projectUid + originalId). If this isn't
// deterministic, git round-trips churn ids; if it isn't namespace-separated, two
// projects sharing seed ids collide on primary keys.
describe('deterministicId', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/

  it('is stable: same inputs → same id', () => {
    expect(deterministicId('proj-1', 'dash-1')).toBe(deterministicId('proj-1', 'dash-1'))
  })

  it('separates by namespace: same key, different project → different id', () => {
    expect(deterministicId('proj-1', 'dash-1')).not.toBe(deterministicId('proj-2', 'dash-1'))
  })

  it('separates by key: same project, different key → different id', () => {
    expect(deterministicId('proj-1', 'a')).not.toBe(deterministicId('proj-1', 'b'))
  })

  it('produces a canonical UUID shape (v4/variant nibbles)', () => {
    expect(deterministicId('proj-1', 'dash-1')).toMatch(UUID_RE)
    expect(deterministicId('', '')).toMatch(UUID_RE)
    expect(deterministicId('x'.repeat(200), 'col-365168366-3')).toMatch(UUID_RE)
  })

  it('has no collisions across a batch of typical ids', () => {
    const keys = ['dash-1', 'tab-1', 'widget-1', 'col-0', 'col-1', 'cohort-a', 'pipe-x', 'b1', 'b2']
    const ids = keys.map((k) => deterministicId('proj-1', k))
    expect(new Set(ids).size).toBe(keys.length)
  })
})
