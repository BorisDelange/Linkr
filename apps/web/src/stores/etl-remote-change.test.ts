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

  beforeEach(() => {
    stored = []
    storedPipeline = pipeline
    initStorage({
      etlPipelines: { getById: async () => storedPipeline },
      etlFiles: { getByPipeline: async () => stored },
    } as unknown as Parameters<typeof initStorage>[0])
    useEtlStore.setState({
      etlPipelines: [pipeline],
      activePipelineId: 'p1',
      files: [file('a', 'A1'), file('b', 'B1')],
      openFileIds: ['a', 'b'],
      selectedFileId: 'b',
      _dirtyMap: new Map(),
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

  it('closes a pipeline deleted elsewhere', async () => {
    storedPipeline = undefined
    await useEtlStore.getState().applyRemoteChange('p1', true)
    const s = useEtlStore.getState()
    expect(s.etlPipelines).toEqual([])
    expect(s.activePipelineId).toBeNull()
    expect(s.files).toEqual([])
  })
})
