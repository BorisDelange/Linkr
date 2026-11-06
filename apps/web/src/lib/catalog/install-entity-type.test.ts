import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { prepareCatalogInstall } from './install'
import type { CatalogEntry } from './types'

/** A catalog entry's type is the index's word; the cloned repo's manifest decides. */

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  isServerMode: () => true,
}))

const clonedFiles: Record<string, unknown> = {}
const storedWorkspaces = vi.hoisted(() => ({ rows: [] as { id: string; lineageId?: string; name: unknown }[] }))
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    workspaces: {
      getAll: async () => storedWorkspaces.rows,
      getById: async (id: string) => storedWorkspaces.rows.find((w) => w.id === id),
    },
  }),
}))
vi.mock('@/lib/api/git', () => ({
  gitCloneToZip: async () => {
    const zip = new JSZip()
    for (const [path, content] of Object.entries(clonedFiles)) zip.file(path, JSON.stringify(content))
    // Bytes, not a Blob: JSZip cannot read a Blob under Node.
    return { blob: await zip.generateAsync({ type: 'uint8array' }), oid: 'abc' }
  },
  gitSetSyncState: async () => {},
}))

const entry = {
  id: 'e1',
  type: 'project',
  name: { en: 'Project' },
  description: { en: '' },
  git: { url: 'https://gitlab.example.org/org/thing', branch: 'main' },
} as CatalogEntry

describe('prepareCatalogInstall', () => {
  it('refuses a repo whose manifest declares another kind than the entry', async () => {
    clonedFiles['entity.json'] = { entityId: 'omop', type: 'schema-preset' }
    const result = await prepareCatalogInstall(entry, 'ws-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('apply-failed')
  })

  it('asks first when a workspace tree carries the lineage of one already here', async () => {
    // The tree decides where the import lands, so the entry's own word does not count.
    storedWorkspaces.rows = [{ id: 'local', lineageId: 'lin-ws', name: { en: 'Mine' } }]
    clonedFiles['entity.json'] = { type: 'workspace', name: { en: 'W' }, lineageId: 'lin-ws' }
    const result = await prepareCatalogInstall({ ...entry, type: 'workspace', lineageId: 'another' } as CatalogEntry)
    expect(result.ok && result.prepared.existingName).toBe('Mine')
  })

  it('writes a first workspace install on click', async () => {
    storedWorkspaces.rows = [{ id: 'local', lineageId: 'lin-other', name: { en: 'Mine' } }]
    clonedFiles['entity.json'] = { type: 'workspace', name: { en: 'W' }, lineageId: 'lin-ws' }
    const result = await prepareCatalogInstall({ ...entry, type: 'workspace' } as CatalogEntry)
    expect(result.ok && result.prepared.existingName).toBeUndefined()
  })
})
