import { describe, it, expect, vi } from 'vitest'
import type { Storage } from '@/lib/storage'
import { importMappingProjectContent } from './import'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))

/** Minimal storage double that records the calls the importer makes.
 *  `getStats` answers from whatever createBatch received, like the real
 *  backends do (one mapped key per distinct source code). */
function makeStore() {
  const calls: Record<string, unknown[][]> = {}
  const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return Promise.resolve() }
  const written: Array<{ sourceConceptCode?: string; status?: string }> = []
  const store = {
    mappingProjects: { create: rec('mp.create'), delete: rec('mp.delete'), update: rec('mp.update') },
    conceptMappings: {
      createBatch: (batch: Array<{ sourceConceptCode?: string; status?: string }>) => {
        written.push(...batch)
        return rec('cm.createBatch')(batch)
      },
      deleteByProject: rec('cm.deleteByProject'),
      getStats: async () => {
        const mapped = new Set(written.filter(m => m.status !== 'ignored').map(m => m.sourceConceptCode))
        const ignored = new Set(written.filter(m => m.status === 'ignored').map(m => m.sourceConceptCode))
        return { mappedCount: mapped.size, approvedCount: 0, flaggedCount: 0, ignoredCount: ignored.size }
      },
    },
    sourceConceptIdRanges: { save: rec('range.save') },
    sourceConceptIdEntries: { saveBatch: rec('entries.saveBatch') },
  } as unknown as Storage
  return { store, calls }
}

const PROJECT_JSON = {
  id: 'repo-id',
  name: { en: 'Adult ICU' },
  sourceType: 'file',
  fileSourceData: { fileName: 'source-concepts.csv', rows: [], columns: [], columnMapping: {} },
  badges: [{ id: 'b1', label: { en: 'Rennes' }, color: 'red' }],
  lineageId: 'lin-1',
}

const CSV = 'concept_name,concept_code\nHeart rate,HR\nSpO2,SPO2'

describe('importMappingProjectContent — full restore parity', () => {
  it('restores project + source concepts + mappings + source-concept-ids under targetId', async () => {
    const { store, calls } = makeStore()

    const files: Record<string, unknown> = {
      'project.json': structuredClone(PROJECT_JSON),
      'source-concepts.csv': CSV,
      'mappings.json': [
        { id: 'm1', sourceConceptCode: 'HR', targetConceptId: 42, comments: [] },
        { id: 'm2', sourceConceptCode: 'SPO2', targetConceptId: 43, comments: [] },
      ],
      'source-concept-ids/ranges.json': [{ badgeLabel: 'Rennes', vocabularyId: 'V', rangeStart: 1, rangeEnd: 100, nextId: 3 }],
      'source-concept-ids/entries.json': {
        columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId'],
        entries: [['Rennes', 'V', 'HR', 1], ['Rennes', 'V', 'SPO2', 2]],
      },
    }

    const ok = await importMappingProjectContent(
      { files, scoresBytes: null },
      { targetId: 'local-target', workspaceId: 'ws-1', replaceExisting: true, gitRemoteConfig: { url: 'https://example/repo', branch: 'main' } },
      store,
    )
    expect(ok).toBe(true)

    // Overwrite cleared the target first.
    expect(calls['cm.deleteByProject']?.[0][0]).toBe('local-target')
    expect(calls['mp.delete']?.[0][0]).toBe('local-target')

    // Project written under targetId + workspace, NOT the repo's own id/ws.
    const created = calls['mp.create']![0][0] as { id: string; workspaceId: string; gitRemoteConfig?: { url: string; branch: string }; fileSourceData: { columns: string[]; totalRowCount: number; rawFileBuffer?: Uint8Array } }
    expect(created.id).toBe('local-target')
    expect(created.workspaceId).toBe('ws-1')
    // Git link preserved (the repo's project.json strips it) — else it drops from git-links.json on re-export.
    expect(created.gitRemoteConfig).toEqual({ url: 'https://example/repo', branch: 'main' })
    // Source concepts restored from CSV → the table has data (the bug was these missing).
    expect(created.fileSourceData.columns).toEqual(['concept_name', 'concept_code'])
    expect(created.fileSourceData.totalRowCount).toBe(2)
    expect(created.fileSourceData.rawFileBuffer).toBeInstanceOf(Uint8Array)

    // Mappings recreated under the target with fresh ids.
    const batch = calls['cm.createBatch']![0][0] as Array<{ projectId: string; sourceConceptCode: string }>
    expect(batch).toHaveLength(2)
    expect(batch.every(m => m.projectId === 'local-target')).toBe(true)

    // Source-concept-id registry retargeted to the workspace.
    const range = calls['range.save']![0][0] as { workspaceId: string; badgeLabel: string }
    expect(range.workspaceId).toBe('ws-1')
    expect(calls['entries.saveBatch']?.[0][0]).toBeDefined()
  })

  it('recomputes stats from the imported mappings, ignoring the stale ones in project.json', async () => {
    // The real symptom: a repo whose project.json says 1472 while mappings.json
    // holds 1474. Importing `stats` verbatim carried the wrong number over, and
    // since mapping ids are regenerated here nothing downstream ever fixed it.
    const { store, calls } = makeStore()
    const files: Record<string, unknown> = {
      'project.json': { ...structuredClone(PROJECT_JSON), stats: { totalSourceConcepts: 10, mappedCount: 1, approvedCount: 9, flaggedCount: 9, ignoredCount: 9, unmappedCount: 9 } },
      'source-concepts.csv': CSV,
      'mappings.json': [
        { id: 'm1', sourceConceptCode: 'HR', targetConceptId: 42, comments: [] },
        { id: 'm2', sourceConceptCode: 'SPO2', targetConceptId: 43, comments: [] },
      ],
    }
    await importMappingProjectContent(
      { files, scoresBytes: null },
      { targetId: 'local-target', workspaceId: 'ws-1' },
      store,
    )

    const [id, changes] = calls['mp.update']![0] as [string, { stats: Record<string, number> }]
    expect(id).toBe('local-target')
    expect(changes.stats.mappedCount).toBe(2)
    expect(changes.stats.approvedCount).toBe(0)
    // totalSourceConcepts describes the SOURCE, not the mappings: the imported
    // value stands, and unmapped follows from it.
    expect(changes.stats.totalSourceConcepts).toBe(10)
    expect(changes.stats.unmappedCount).toBe(8)
  })

  it('falls back to the restored CSV row count when the import carries no total', async () => {
    const { store, calls } = makeStore()
    const files: Record<string, unknown> = {
      'project.json': structuredClone(PROJECT_JSON),
      'source-concepts.csv': CSV,
      'mappings.json': [{ id: 'm1', sourceConceptCode: 'HR', targetConceptId: 42, comments: [] }],
    }
    await importMappingProjectContent(
      { files, scoresBytes: null },
      { targetId: 'local-target', workspaceId: 'ws-1' },
      store,
    )
    const [, changes] = calls['mp.update']![0] as [string, { stats: Record<string, number> }]
    expect(changes.stats.totalSourceConcepts).toBe(2)
    expect(changes.stats.unmappedCount).toBe(1)
  })

  it('returns false when the ZIP has no project.json', async () => {
    const { store } = makeStore()
    const ok = await importMappingProjectContent(
      { files: { 'mappings.json': [] }, scoresBytes: null },
      { targetId: 't', workspaceId: 'ws', replaceExisting: false },
      store,
    )
    expect(ok).toBe(false)
  })
})
