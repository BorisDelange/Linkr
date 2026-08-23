import { describe, expect, it } from 'vitest'
import { catalogTypeForScope } from './scope'
import { ENTRY_TYPES } from './types'

describe('catalogTypeForScope', () => {
  it('maps every catalog entry type back from some scope', () => {
    // A missing pair is silent in the UI — the import dialog just loses its catalog
    // tab — so the mapping is asserted to be total over the published types.
    const mapped = new Set(
      (['projects', 'mapping-projects', 'sql-script-collections', 'etl-pipelines',
        'data-catalogs', 'dq-rule-sets', 'schema-presets'] as const)
        .map(catalogTypeForScope),
    )
    for (const type of ENTRY_TYPES) expect(mapped).toContain(type)
  })

  it('maps the scopes whose plural name differs from the type name', () => {
    expect(catalogTypeForScope('sql-script-collections')).toBe('sql-collection')
    expect(catalogTypeForScope('mapping-projects')).toBe('mapping-project')
    expect(catalogTypeForScope('schema-presets')).toBe('schema-preset')
  })

  it('returns undefined for scopes the catalog does not publish', () => {
    expect(catalogTypeForScope('workspaces')).toBeUndefined()
    expect(catalogTypeForScope('settings')).toBeUndefined()
    expect(catalogTypeForScope('user-plugins')).toBeUndefined()
    expect(catalogTypeForScope(undefined)).toBeUndefined()
  })
})
