import { describe, it, expect, vi, beforeEach } from 'vitest'

const gitMocks = vi.hoisted(() => ({ gitSetSyncState: vi.fn(async () => {}) }))
// Only the network call is stubbed: `scopeForLinkedType` stays the real map, so a
// type dropped from it fails these cases instead of passing against a copy.
vi.mock('@/lib/api/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/git')>()),
  ...gitMocks,
}))

const { anchorClonedEntity } = await import('./git-clone-anchor')

const OID = '6ced4a58497fdc24d1e703f63a00f41f65c5ebac'

beforeEach(() => {
  gitMocks.gitSetSyncState.mockReset()
  gitMocks.gitSetSyncState.mockResolvedValue(undefined)
})

describe('anchorClonedEntity', () => {
  // The regression this file exists for: the workspace-import clone loop anchored
  // ONLY mapping projects, so a git-linked project imported as part of a workspace
  // landed with no baseline — sync-state then reported behind:false forever and the
  // Versioning page never offered a pull.
  it.each([
    ['project', 'projects'],
    ['mapping-project', 'mapping-projects'],
    ['sql-collection', 'sql-script-collections'],
    ['etl-pipeline', 'etl-pipelines'],
    ['data-catalog', 'data-catalogs'],
    ['dq-rule-set', 'dq-rule-sets'],
    ['schema-preset', 'schema-presets'],
    // A database anchors like the rest since it gained a versioning panel: without
    // a baseline its all-or-nothing pull would never learn the remote moved.
    ['database', 'databases'],
  ] as const)('anchors a %s against scope %s', async (type, scope) => {
    await anchorClonedEntity(type, 'e1', 'main', OID)
    expect(gitMocks.gitSetSyncState).toHaveBeenCalledExactlyOnceWith(scope, 'e1', 'main', OID)
  })

  it('skips types with no git scope of their own', async () => {
    // A workspace is anchored by its installer, not through this helper.
    await anchorClonedEntity('workspace', 'ws1', 'main', OID)
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })

  // The two maps once differed: a database could report its content missing but
  // not be versioned. Now every linkable type answers yes to both, so the maps
  // coincide — asserted so a type added to one but not the other is caught.
  it('resolves every linkable type through both maps', async () => {
    const { scopeForLinkedType, contentScopeForLinkedType, linkedTypeForScope } =
      await import('@/lib/api/git')
    expect(scopeForLinkedType['database']).toBe('databases')
    expect(contentScopeForLinkedType['database']).toBe('databases')
    for (const [type, scope] of Object.entries(scopeForLinkedType)) {
      expect(contentScopeForLinkedType[type]).toBe(scope)
    }
    // The badge resolves a scope back to the type it names.
    expect(linkedTypeForScope['databases']).toBe('database')
  })

  it('skips when the clone reported no oid', async () => {
    await anchorClonedEntity('project', 'p1', 'main', null)
    await anchorClonedEntity('project', 'p1', 'main', undefined)
    await anchorClonedEntity('project', 'p1', 'main', '')
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })

  it('passes the branch through rather than assuming main', async () => {
    await anchorClonedEntity('etl-pipeline', 'e1', 'release/2.0', OID)
    expect(gitMocks.gitSetSyncState).toHaveBeenCalledExactlyOnceWith(
      'etl-pipelines', 'e1', 'release/2.0', OID,
    )
  })

  it('swallows a failing anchor call — an unanchored entity is still usable', async () => {
    gitMocks.gitSetSyncState.mockRejectedValue(new Error('offline'))
    await expect(anchorClonedEntity('project', 'p1', 'main', OID)).resolves.toBeUndefined()
  })
})
