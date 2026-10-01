import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Storage } from '@/lib/storage'
import { importMappingProjectContent, MappingOverwriteForbiddenError } from './import'
import { NO_SCORES } from './scores-restore'

/** An overwrite deletes the existing row first: a user who may not delete is refused up front. */

const permissions = vi.hoisted(() => ({ value: [] as string[] }))

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  isServerMode: () => true,
}))
vi.mock('@/lib/api/members', () => ({
  membersApi: { myWorkspaceRole: async () => ({ role: 'editor', permissions: permissions.value }) },
}))

function makeStore() {
  const deleted: string[] = []
  const store = {
    mappingProjects: {
      create: async () => {},
      delete: async () => { deleted.push('project') },
      update: async () => {},
    },
    conceptMappings: {
      createBatch: async () => {},
      deleteByProject: async () => { deleted.push('mappings') },
      getStats: async () => ({ mappedCount: 0, approvedCount: 0, flaggedCount: 0, ignoredCount: 0 }),
    },
  } as unknown as Storage
  return { store, deleted }
}

const files = { 'entity.json': { type: 'mapping-project', name: { en: 'MP' }, sourceType: 'database' }, 'mappings.json': [] }

describe('importMappingProjectContent — overwrite', () => {
  beforeEach(() => { permissions.value = [] })

  it('refuses before deleting anything when the user may not delete mapping projects', async () => {
    permissions.value = ['concept-mapping:write']
    const { store, deleted } = makeStore()
    await expect(importMappingProjectContent(
      { files, scores: NO_SCORES },
      { targetId: 't', workspaceId: 'ws-1', replaceExisting: true },
      store,
    )).rejects.toBeInstanceOf(MappingOverwriteForbiddenError)
    expect(deleted).toEqual([])
  })

  it('replaces the row when the user may delete', async () => {
    permissions.value = ['concept-mapping:write', 'concept-mapping:delete']
    const { store, deleted } = makeStore()
    const ok = await importMappingProjectContent(
      { files, scores: NO_SCORES },
      { targetId: 't', workspaceId: 'ws-1', replaceExisting: true },
      store,
    )
    expect(ok).toBe(true)
    expect(deleted).toEqual(['mappings', 'project'])
  })
})
