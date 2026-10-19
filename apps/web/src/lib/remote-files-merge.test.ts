import { describe, expect, it } from 'vitest'
import { dropOrphan, mergeRemoteFiles, type EditorFilesState } from './remote-files-merge'

interface File { id: string; content?: string | null; parentId?: string | null }

const state = (files: File[], over: Partial<EditorFilesState<File>> = {}): EditorFilesState<File> => ({
  files,
  openFileIds: files.map((f) => f.id),
  selectedFileId: files[0]?.id ?? null,
  _dirtyMap: new Map(),
  orphanedFileIds: [],
  ...over,
})

const dirtyOf = (s: EditorFilesState<File>) => (id: string) => s._dirtyMap.has(id)

describe('mergeRemoteFiles', () => {
  it('keeps the unsaved text and makes the stored version the revert point', () => {
    const before = state([{ id: 'a', content: 'mine' }], { _dirtyMap: new Map([['a', 'old']]) })
    const merged = mergeRemoteFiles(before, [{ id: 'a', content: 'agent' }], dirtyOf(before))
    expect(merged.files).toEqual([{ id: 'a', content: 'mine' }])
    expect(merged._dirtyMap.get('a')).toBe('agent')
    expect(merged.orphanedFileIds).toEqual([])
  })

  it('takes the stored content of a file without unsaved edits', () => {
    const before = state([{ id: 'a', content: 'old' }])
    const merged = mergeRemoteFiles(before, [{ id: 'a', content: 'agent' }, { id: 'b', content: 'new' }], dirtyOf(before))
    expect(merged.files.map((f) => f.content)).toEqual(['agent', 'new'])
    expect(merged.openFileIds).toEqual(['a'])
  })

  it('closes a deleted file without unsaved edits', () => {
    const before = state([{ id: 'a' }, { id: 'b' }], { selectedFileId: 'b' })
    const merged = mergeRemoteFiles(before, [{ id: 'a' }], dirtyOf(before))
    expect(merged.files.map((f) => f.id)).toEqual(['a'])
    expect(merged.openFileIds).toEqual(['a'])
    expect(merged.selectedFileId).toBe('a')
  })

  it('keeps a deleted file with unsaved edits, orphaned, open and selected', () => {
    const before = state([{ id: 'a' }, { id: 'b', content: 'mine', parentId: 'a' }], {
      selectedFileId: 'b', _dirtyMap: new Map([['b', 'saved']]),
    })
    const merged = mergeRemoteFiles(before, [{ id: 'a' }], dirtyOf(before))
    expect(merged.files).toEqual([{ id: 'a' }, { id: 'b', content: 'mine', parentId: 'a' }])
    expect(merged.orphanedFileIds).toEqual(['b'])
    expect(merged.openFileIds).toEqual(['a', 'b'])
    expect(merged.selectedFileId).toBe('b')
    expect(merged._dirtyMap.get('b')).toBe('saved')
  })

  it('moves an orphan to the root when its folder went too', () => {
    const before = state([{ id: 'dir' }, { id: 'b', content: 'mine', parentId: 'dir' }], { _dirtyMap: new Map([['b', '']]) })
    const merged = mergeRemoteFiles(before, [], dirtyOf(before))
    expect(merged.files).toEqual([{ id: 'b', content: 'mine', parentId: null }])
  })

  it('stays orphaned across re-reads, and stops being one when the file is back', () => {
    const first = state([{ id: 'b', content: 'mine' }], { _dirtyMap: new Map([['b', 'saved']]) })
    const orphaned = mergeRemoteFiles(first, [], dirtyOf(first))
    const again = mergeRemoteFiles(orphaned, [], dirtyOf(orphaned))
    expect(again.orphanedFileIds).toEqual(['b'])
    expect(again.files[0].content).toBe('mine')

    const back = mergeRemoteFiles(again, [{ id: 'b', content: 'agent' }], dirtyOf(again))
    expect(back.orphanedFileIds).toEqual([])
    expect(back.files[0].content).toBe('mine')
    expect(back._dirtyMap.get('b')).toBe('agent')
  })
})

describe('dropOrphan', () => {
  it('removes the file from the tree, the tabs and the dirty map', () => {
    const before = state([{ id: 'a' }, { id: 'b', content: 'mine' }], {
      selectedFileId: 'b', _dirtyMap: new Map([['b', '']]), orphanedFileIds: ['b'],
    })
    const after = dropOrphan(before, 'b')
    expect(after.files.map((f) => f.id)).toEqual(['a'])
    expect(after.openFileIds).toEqual(['a'])
    expect(after.selectedFileId).toBe('a')
    expect(after._dirtyMap.size).toBe(0)
    expect(after.orphanedFileIds).toEqual([])
  })
})
