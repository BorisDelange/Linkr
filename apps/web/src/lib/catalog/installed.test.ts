import { describe, it, expect } from 'vitest'
import { findInstalled, isOutdated, normalizeGitUrl } from './installed'
import type { Storage } from '@/lib/storage'
import type { CatalogEntry } from './types'

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'e1',
    type: 'sql-collection',
    git: { url: 'https://framagit.org/g/repo', branch: 'main' },
    name: { en: 'Entry' },
    description: {},
    ...over,
  }
}

/** A Storage stub exposing only the collections findInstalled reads. */
function storageWith(rows: Record<string, unknown[]>): Storage {
  const coll = (key: string) => ({ getAll: async () => rows[key] ?? [] })
  return {
    sqlScriptCollections: coll('sqlScriptCollections'),
    etlPipelines: coll('etlPipelines'),
    dataCatalogs: coll('dataCatalogs'),
    dqRuleSets: coll('dqRuleSets'),
    mappingProjects: coll('mappingProjects'),
    projects: coll('projects'),
    schemaPresets: coll('schemaPresets'),
    dataSources: coll('dataSources'),
    workspaces: coll('workspaces'),
  } as unknown as Storage
}

describe('normalizeGitUrl', () => {
  it('ignores a .git suffix, trailing slashes and case', () => {
    const canonical = normalizeGitUrl('https://framagit.org/g/repo')
    expect(normalizeGitUrl('https://framagit.org/g/repo.git')).toBe(canonical)
    expect(normalizeGitUrl('https://framagit.org/g/repo///')).toBe(canonical)
    expect(normalizeGitUrl('https://FramaGit.org/G/Repo')).toBe(canonical)
  })

  it('maps an absent url to the empty string', () => {
    expect(normalizeGitUrl(undefined)).toBe('')
  })
})

// The Update button hangs off this predicate, so the "don't nag" cases matter as much
// as the positive one: an entry with no version must never look permanently outdated.
describe('isOutdated', () => {
  it('is true only when both versions are known and differ', () => {
    expect(isOutdated(entry({ version: '1.2.0' }), { id: 'a', version: '1.1.0' })).toBe(true)
  })

  it('is false when the versions match', () => {
    expect(isOutdated(entry({ version: '1.2.0' }), { id: 'a', version: '1.2.0' })).toBe(false)
  })

  it('is false when either side declares no version', () => {
    expect(isOutdated(entry({ version: '1.2.0' }), { id: 'a' })).toBe(false)
    expect(isOutdated(entry(), { id: 'a', version: '1.1.0' })).toBe(false)
    expect(isOutdated(entry(), { id: 'a' })).toBe(false)
  })
})

describe('findInstalled', () => {
  it('matches on lineageId ahead of the git url', async () => {
    const storage = storageWith({
      sqlScriptCollections: [
        { id: 'local-1', workspaceId: 'ws1', lineageId: 'lin-1', version: '1.0.0' },
      ],
    })
    const found = await findInstalled([entry({ lineageId: 'lin-1', version: '1.1.0' })], 'ws1', storage)
    expect(found.e1).toMatchObject({ id: 'local-1', state: 'outdated', version: '1.0.0' })
  })

  it('falls back to the git url when either side has no lineage', async () => {
    const storage = storageWith({
      sqlScriptCollections: [
        { id: 'local-1', workspaceId: 'ws1', gitRemoteConfig: { url: 'https://framagit.org/g/repo.git' } },
      ],
    })
    const found = await findInstalled([entry()], 'ws1', storage)
    expect(found.e1).toMatchObject({ id: 'local-1', state: 'installed' })
  })

  it('falls back to the git url when BOTH lineages exist but differ', async () => {
    // The MIMIC-IV demo case: the catalog entry publishes a lineage, its repo
    // does not, so the install minted a local one. Both sides then had a lineage
    // and the comparison ended there — the entry stayed "Install" forever even
    // though the two name the same remote.
    const storage = storageWith({
      sqlScriptCollections: [{
        id: 'local-1',
        workspaceId: 'ws1',
        lineageId: 'locally-minted',
        gitRemoteConfig: { url: 'https://framagit.org/g/repo' },
      }],
    })
    const found = await findInstalled([entry({ lineageId: 'lin-1' })], 'ws1', storage)
    expect(found.e1).toMatchObject({ id: 'local-1', state: 'installed' })
  })

  it('prefers the lineage match over a url match on a different row', async () => {
    // The fallback must not outrank lineage: a fork shares the remote URL, so
    // whichever row carries the published lineage is the real installed copy.
    const storage = storageWith({
      sqlScriptCollections: [
        { id: 'fork', workspaceId: 'ws1', gitRemoteConfig: { url: 'https://framagit.org/g/repo' } },
        { id: 'real', workspaceId: 'ws1', lineageId: 'lin-1' },
      ],
    })
    const found = await findInstalled([entry({ lineageId: 'lin-1' })], 'ws1', storage)
    expect(found.e1).toMatchObject({ id: 'real' })
  })

  it('ignores copies living in another workspace', async () => {
    const storage = storageWith({
      sqlScriptCollections: [{ id: 'local-1', workspaceId: 'ws2', lineageId: 'lin-1' }],
    })
    expect(await findInstalled([entry({ lineageId: 'lin-1' })], 'ws1', storage)).toEqual({})
  })

  it('does not match a row of a different entity type', async () => {
    const storage = storageWith({
      etlPipelines: [{ id: 'local-1', workspaceId: 'ws1', lineageId: 'lin-1' }],
    })
    expect(await findInstalled([entry({ lineageId: 'lin-1' })], 'ws1', storage)).toEqual({})
  })

  it('finds an installed workspace, which has no parent workspace to be scoped to', async () => {
    // A workspace row carries no workspaceId, so scoping it like the other types
    // would discard every row and the entry would always read as not installed.
    const storage = storageWith({
      workspaces: [{ id: 'ws-installed', lineageId: 'lin-w' }],
    })
    const found = await findInstalled(
      [entry({ id: 'e-ws', type: 'workspace', lineageId: 'lin-w' })],
      'ws1',
      storage,
    )
    expect(found['e-ws']).toMatchObject({ id: 'ws-installed', state: 'installed' })
  })

  it('still finds an installed workspace when no workspace is selected', async () => {
    // Landing on the catalog with nothing selected is the normal first-run state,
    // and a workspace entry does not depend on a selection — it IS the scope. The
    // callers used to skip the lookup entirely on an empty workspaceId, so a
    // workspace already installed kept reading "Install".
    const storage = storageWith({
      workspaces: [{ id: 'ws-installed', lineageId: 'lin-w' }],
    })
    const found = await findInstalled(
      [entry({ id: 'e-ws', type: 'workspace', lineageId: 'lin-w' })],
      '',
      storage,
    )
    expect(found['e-ws']).toMatchObject({ id: 'ws-installed', state: 'installed' })
  })

  it('reads a project by its uid, not an id field', async () => {
    const storage = storageWith({
      projects: [{ uid: 'proj-uid', workspaceId: 'ws1', lineageId: 'lin-p' }],
    })
    const found = await findInstalled(
      [entry({ id: 'e-proj', type: 'project', lineageId: 'lin-p' })],
      'ws1',
      storage,
    )
    expect(found['e-proj']).toMatchObject({ id: 'proj-uid', state: 'installed' })
  })
})
