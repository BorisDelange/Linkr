import { describe, expect, it } from 'vitest'
import { INSTALL_ONLY_TYPES, catalogTypeForScope } from './scope'
import { ENTRY_TYPES } from './types'

describe('catalogTypeForScope', () => {
  it('maps every pushable catalog entry type back from some scope', () => {
    // A missing pair is silent in the UI — the import dialog just loses its catalog
    // tab — so the mapping is asserted to be total over the published types, minus
    // the install-only ones (a database is cloned in, never pushed out).
    const mapped = new Set(
      (['workspaces', 'projects', 'mapping-projects', 'sql-script-collections',
        'etl-pipelines', 'data-catalogs', 'dq-rule-sets', 'schema-presets'] as const)
        .map(catalogTypeForScope),
    )
    for (const type of ENTRY_TYPES) {
      if (INSTALL_ONLY_TYPES.includes(type)) continue
      expect(mapped).toContain(type)
    }
  })

  it('gives a database no scope, so nothing offers to push one', () => {
    // The app never exports a row; a scope mapping to 'database' would put a push
    // button on the one entity whose tree carries data.
    expect(INSTALL_ONLY_TYPES).toContain('database')
    const everyScope = [
      'projects', 'workspaces', 'mapping-projects', 'sql-script-collections',
      'etl-pipelines', 'data-catalogs', 'dq-rule-sets', 'schema-presets',
      'user-plugins', 'settings',
    ] as const
    for (const scope of everyScope) {
      expect(INSTALL_ONLY_TYPES).not.toContain(catalogTypeForScope(scope))
    }
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
