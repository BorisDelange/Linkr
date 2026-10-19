import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSqlScriptsStore } from './sql-scripts-store'
import { initStorage } from '@/lib/storage'
import type { SqlScriptCollection, SqlScriptFile } from '@/types'

/**
 * An agent writes a collection's scripts while the user may have it open: the
 * tab must show the new files without losing what the user was typing.
 */

const file = (id: string, content: string): SqlScriptFile =>
  ({ id, collectionId: 'c1', name: `${id}.sql`, type: 'file', parentId: null, content, order: 0 }) as SqlScriptFile

const collection = { id: 'c1', workspaceId: 'ws', name: { en: 'Scripts' } } as unknown as SqlScriptCollection

const contents = () => useSqlScriptsStore.getState().files.map((f) => [f.id, f.content])

describe('SQL scripts store: a change made elsewhere', () => {
  let stored: SqlScriptFile[]
  let storedCollection: SqlScriptCollection | undefined
  let created: SqlScriptFile[]
  let duringRead: (() => Promise<void>) | undefined

  beforeEach(() => {
    stored = []
    storedCollection = collection
    created = []
    duringRead = undefined
    initStorage({
      sqlScriptCollections: { getById: async () => storedCollection },
      sqlScriptFiles: {
        getByCollection: async () => {
          const snapshot = stored.map((f) => ({ ...f }))
          const hook = duringRead
          duringRead = undefined
          await hook?.()
          return snapshot
        },
        create: async (f: SqlScriptFile) => { created.push(f) },
        update: async (id: string, changes: Partial<SqlScriptFile>) => {
          stored = stored.map((f) => (f.id === id ? { ...f, ...changes } : f))
        },
      },
    } as unknown as Parameters<typeof initStorage>[0])
    useSqlScriptsStore.setState({
      collections: [collection],
      activeCollectionId: 'c1',
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
    await useSqlScriptsStore.getState().applyRemoteChange('c1', false)
    const s = useSqlScriptsStore.getState()
    expect(contents()).toEqual([['a', 'A2'], ['c', 'C1']])
    expect(s.openFileIds).toEqual(['a'])
    expect(s.selectedFileId).toBe('a')
  })

  it('keeps an unsaved edit, and Revert goes back to the agent version', async () => {
    useSqlScriptsStore.getState().updateFileContent('a', 'mine')
    stored = [file('a', 'A2'), file('b', 'B2')]
    await useSqlScriptsStore.getState().applyRemoteChange('c1', false)
    expect(contents()).toEqual([['a', 'mine'], ['b', 'B2']])
    expect(useSqlScriptsStore.getState().isFileDirty('a')).toBe(true)
    useSqlScriptsStore.getState().revertFile('a')
    expect(contents()[0]).toEqual(['a', 'A2'])
  })

  it('keeps a file with an unsaved edit the agent deleted, and Save re-creates it', async () => {
    useSqlScriptsStore.getState().updateFileContent('b', 'mine')
    stored = [file('a', 'A1')]
    await useSqlScriptsStore.getState().applyRemoteChange('c1', false)
    let s = useSqlScriptsStore.getState()
    expect(s.orphanedFileIds).toEqual(['b'])
    expect(s.selectedFileId).toBe('b')
    expect(contents()).toEqual([['a', 'A1'], ['b', 'mine']])

    await s.saveFile('b')
    s = useSqlScriptsStore.getState()
    expect(created.map((f) => [f.id, f.content])).toEqual([['b', 'mine']])
    expect(s.orphanedFileIds).toEqual([])
    expect(s.isFileDirty('b')).toBe(false)
  })

  it('keeps what the user saved while the tree was being read', async () => {
    stored = [file('a', 'A1'), file('b', 'B1')]
    useSqlScriptsStore.getState().updateFileContent('a', 'mine')
    duringRead = () => useSqlScriptsStore.getState().saveFile('a')
    await useSqlScriptsStore.getState().applyRemoteChange('c1', false)
    expect(contents()).toEqual([['a', 'mine'], ['b', 'B1']])
    expect(useSqlScriptsStore.getState().isFileDirty('a')).toBe(false)
  })

  it('closes a collection deleted elsewhere', async () => {
    storedCollection = undefined
    await useSqlScriptsStore.getState().applyRemoteChange('c1', true)
    const s = useSqlScriptsStore.getState()
    expect(s.collections).toEqual([])
    expect(s.activeCollectionId).toBeNull()
    expect(s.files).toEqual([])
    expect(s.openFileIds).toEqual([])
  })
})
