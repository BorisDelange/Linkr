import { describe, expect, it } from 'vitest'
import { REINSTALLABLE } from './entity-reinstall'

describe('REINSTALLABLE', () => {
  // applyClonedEntity is what rebuilds the content; a scope mapped to a type it
  // cannot rebuild would offer a Reinstall button that always fails.
  const REBUILDABLE = [
    'project', 'mapping-project', 'sql-collection', 'etl-pipeline',
    'data-catalog', 'dq-rule-set', 'schema-preset', 'database',
  ]

  it('maps every scope to a type applyClonedEntity can rebuild', () => {
    for (const [scope, entry] of Object.entries(REINSTALLABLE)) {
      expect(REBUILDABLE, `scope ${scope}`).toContain(entry.type)
    }
  })

  it('maps each type exactly once, so no two scopes rebuild the same kind', () => {
    const types = Object.values(REINSTALLABLE).map((e) => e.type)
    expect(new Set(types).size).toBe(types.length)
  })

  // These have no applyClonedEntity branch: offering the action would delete the
  // content and then fail to bring it back.
  it('excludes the scopes that cannot be rebuilt from a clone', () => {
    expect(REINSTALLABLE).not.toHaveProperty('workspaces')
    expect(REINSTALLABLE).not.toHaveProperty('user-plugins')
    expect(REINSTALLABLE).not.toHaveProperty('settings')
  })

  it('covers the eight rebuildable kinds', () => {
    expect(Object.keys(REINSTALLABLE)).toHaveLength(8)
  })
})
