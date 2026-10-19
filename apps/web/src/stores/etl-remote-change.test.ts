import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useEtlStore } from './etl-store'
import { initStorage } from '@/lib/storage'
import type { EtlFile, EtlPipeline } from '@/types'

/**
 * An agent writes a pipeline's scripts while the user may have it open: the tab
 * must show the new files without losing what the user was typing.
 */

const file = (id: string, content: string): EtlFile =>
  ({ id, pipelineId: 'p1', name: `${id}.sql`, type: 'file', parentId: null, content, order: 0 }) as EtlFile

const pipeline = { id: 'p1', workspaceId: 'ws', name: { en: 'ETL' } } as unknown as EtlPipeline

describe('ETL store: a change made elsewhere', () => {
  let stored: EtlFile[]
  let storedPipeline: EtlPipeline | undefined
  let created: EtlFile[]

  beforeEach(() => {
    stored = []
    storedPipeline = pipeline
    created = []
    initStorage({
      etlPipelines: { getById: async () => storedPipeline },
      etlFiles: { getByPipeline: async () => stored, create: async (f: EtlFile) => { created.push(f) } },
    } as unknown as Parameters<typeof initStorage>[0])
    useEtlStore.setState({
      etlPipelines: [pipeline],
      activePipelineId: 'p1',
      files: [file('a', 'A1'), file('b', 'B1')],
      openFileIds: ['a', 'b'],
      selectedFileId: 'b',
      _dirtyMap: new Map(),
      orphanedFileIds: [],
    })
  })

  afterEach(() => {
    initStorage(undefined as unknown as Parameters<typeof initStorage>[0])
  })

  it('shows what the agent wrote, and drops what it deleted', async () => {
    stored = [file('a', 'A2'), file('c', 'C1')]
    await useEtlStore.getState().applyRemoteChange('p1', false)
    const s = useEtlStore.getState()
    expect(s.files.map((f) => [f.id, f.content])).toEqual([['a', 'A2'], ['c', 'C1']])
    expect(s.openFileIds).toEqual(['a'])
    expect(s.selectedFileId).toBe('a')
  })

  it('keeps an unsaved edit, and Revert goes back to the agent version', async () => {
    useEtlStore.getState().updateFileContent('a', 'mine')
    stored = [file('a', 'A2'), file('b', 'B2')]
    await useEtlStore.getState().applyRemoteChange('p1', false)
    expect(useEtlStore.getState().files.find((f) => f.id === 'a')?.content).toBe('mine')
    expect(useEtlStore.getState().isFileDirty('a')).toBe(true)
    useEtlStore.getState().revertFile('a')
    expect(useEtlStore.getState().files.find((f) => f.id === 'a')?.content).toBe('A2')
  })

  it('keeps a file with an unsaved edit the agent deleted, and Save re-creates it', async () => {
    useEtlStore.getState().updateFileContent('b', 'mine')
    stored = [file('a', 'A1')]
    await useEtlStore.getState().applyRemoteChange('p1', false)
    let s = useEtlStore.getState()
    expect(s.orphanedFileIds).toEqual(['b'])
    expect(s.selectedFileId).toBe('b')
    expect(s.files.find((f) => f.id === 'b')?.content).toBe('mine')

    await s.saveFile('b')
    s = useEtlStore.getState()
    expect(created.map((f) => [f.id, f.content])).toEqual([['b', 'mine']])
    expect(s.orphanedFileIds).toEqual([])
    expect(s.isFileDirty('b')).toBe(false)
  })

  it('drops an orphaned file the user closes', async () => {
    useEtlStore.getState().updateFileContent('b', 'mine')
    stored = [file('a', 'A1')]
    await useEtlStore.getState().applyRemoteChange('p1', false)
    useEtlStore.getState().closeFile('b')
    const s = useEtlStore.getState()
    expect(s.files.map((f) => f.id)).toEqual(['a'])
    expect(s.orphanedFileIds).toEqual([])
    expect(created).toEqual([])
  })

  it('closes a pipeline deleted elsewhere', async () => {
    storedPipeline = undefined
    await useEtlStore.getState().applyRemoteChange('p1', true)
    const s = useEtlStore.getState()
    expect(s.etlPipelines).toEqual([])
    expect(s.activePipelineId).toBeNull()
    expect(s.files).toEqual([])
  })
})
