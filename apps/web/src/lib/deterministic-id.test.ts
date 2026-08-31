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

  it('rejects a non-string owner rather than failing deep inside', () => {
    expect(() => deterministicId(undefined as unknown as string, 'queries/a.sql')).toThrow(TypeError)
  })

  it('has no collisions across a batch of typical ids', () => {
    const keys = ['dash-1', 'tab-1', 'widget-1', 'col-0', 'col-1', 'cohort-a', 'pipe-x', 'b1', 'b2']
    const ids = keys.map((k) => deterministicId('proj-1', k))
    expect(new Set(ids).size).toBe(keys.length)
  })

  it("disambiguates a ':' inside a part (no boundary collision)", () => {
    // Without escaping, ('a:b','c') and ('a','b:c') both hash "a:b:c" → collide.
    expect(deterministicId('a:b', 'c')).not.toBe(deterministicId('a', 'b:c'))
    expect(deterministicId('proj:1', 'dash')).not.toBe(deterministicId('proj', '1:dash'))
  })

  it('stays collision-free at scale (20 projects × 5k keys)', () => {
    const ids = new Set<string>()
    const total = 20 * 5_000
    for (let p = 0; p < 20; p++) {
      for (let i = 0; i < 5_000; i++) ids.add(deterministicId(`proj-${p}`, `ent-${i}`))
    }
    expect(ids.size).toBe(total) // any collision would shrink the Set
  })
})
