import { describe, expect, it } from 'vitest'
import { INSTALL_ONLY_TYPES, catalogTypeForScope } from './scope'
import { ENTRY_TYPES } from './types'

describe('catalogTypeForScope', () => {
  it('maps every pushable catalog entry type back from some scope', () => {
    // A missing pair is silent in the UI — the import dialog just loses its catalog
    // tab — so the mapping is asserted to be total over the published types, minus
    // any install-only ones.
    const mapped = new Set(
      (['workspaces', 'projects', 'mapping-projects', 'sql-script-collections',
        'etl-pipelines', 'data-catalogs', 'dq-rule-sets', 'schema-presets',
        'databases'] as const)
        .map(catalogTypeForScope),
    )
    for (const type of ENTRY_TYPES) {
      if (INSTALL_ONLY_TYPES.includes(type)) continue
      expect(mapped).toContain(type)
    }
  })

  it('gives a database a scope, so its versioning panel can push', () => {
    // Databases became versionable; what keeps rows out of a push is the export
    // tree (metadata only), not the absence of a scope.
    expect(catalogTypeForScope('databases')).toBe('database')
    expect(INSTALL_ONLY_TYPES).not.toContain('database')
  })

  it('maps the scopes whose plural name differs from the type name', () => {
    expect(catalogTypeForScope('sql-script-collections')).toBe('sql-collection')
    expect(catalogTypeForScope('mapping-projects')).toBe('mapping-project')
    expect(catalogTypeForScope('schema-presets')).toBe('schema-preset')
  })

  it('publishes a workspace, so its import dialog offers the catalog too', () => {
    // The demo/default content ships as one curated workspace pulling its children
    // in through their git links (default-data-repos-plan.md, decision 6).
    expect(catalogTypeForScope('workspaces')).toBe('workspace')
  })

  it('returns undefined for scopes the catalog does not publish', () => {
    expect(catalogTypeForScope('settings')).toBeUndefined()
    expect(catalogTypeForScope('user-plugins')).toBeUndefined()
    expect(catalogTypeForScope(undefined)).toBeUndefined()
  })
})
