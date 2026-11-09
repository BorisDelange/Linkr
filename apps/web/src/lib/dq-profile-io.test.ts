import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildDqProfileFolder, resolveProfileSources } from './entity-io'
import type { Storage } from '@/lib/storage'
import type { DqProfile, DqRuleSet } from '@/types'

const ruleSet = (id: string, workspaceId: string, lineageId?: string, entityId?: string) =>
  ({ id, workspaceId, lineageId, entityId, name: { en: id } }) as unknown as DqRuleSet

describe('quality profile export / import', () => {
  it('writes its rule sets as pointers only, never their local ids', async () => {
    const profile = {
      id: 'p1', workspaceId: 'ws', name: { en: 'P' }, description: {}, dataSourceId: 'db-local', status: 'draft',
      sources: [{ ruleSetId: 'rs-local', ruleSetRef: { lineageId: 'lin' }, mode: 'all' }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    } as unknown as DqProfile
    const storage = { readmeAttachments: { getByOwner: async () => [] } } as unknown as Storage
    const zip = new JSZip()
    await buildDqProfileFolder(zip, '', profile, storage)
    const manifest = JSON.parse(await zip.file('entity.json')!.async('string'))
    expect(manifest.type).toBe('dq-profile')
    expect(manifest.dataSourceId).toBe('')
    expect(manifest.sources).toEqual([{ ruleSetRef: { lineageId: 'lin' }, mode: 'all' }])
  })

  it('points each source at the rule set its ref names in the workspace, else at none', async () => {
    const storage = {
      dqRuleSets: {
        getByWorkspace: async () => [ruleSet('a', 'ws', 'lin-a'), ruleSet('b', 'ws', undefined, 'slug-b')],
      },
    } as unknown as Storage
    const sources = await resolveProfileSources([
      { ruleSetId: 'stale', ruleSetRef: { lineageId: 'lin-a' }, mode: 'all' },
      { ruleSetRef: { entityId: 'slug-b' }, mode: 'selected', checkKeys: ['k'] } as never,
      { ruleSetRef: { lineageId: 'elsewhere' }, mode: 'all' } as never,
    ], storage, 'ws')
    expect(sources.map((s) => s.ruleSetId)).toEqual(['a', 'b', ''])
    expect(Object.keys(sources[1])[0]).toBe('ruleSetId')
  })
})
