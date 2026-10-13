import { describe, it, expect } from 'vitest'
import { datasetsNodePath, dropMarksUnder, restoreMarks, scriptsNodePath } from './versioning-marks'

describe('node paths', () => {
  const files = [
    { id: 'root', name: 'scripts', parentId: null, type: 'folder' },
    { id: 'dir', name: 'ref', parentId: 'root', type: 'folder' },
    { id: 'f', name: 'codes.csv', parentId: 'dir', type: 'file' },
  ]

  it('stops at the synthetic scripts root for IDE files', () => {
    expect(scriptsNodePath(files, 'f')).toBe('ref/codes.csv')
  })

  it('keeps every ancestor for dataset files', () => {
    expect(datasetsNodePath(files, 'f')).toBe('scripts/ref/codes.csv')
  })
})

describe('dropMarksUnder', () => {
  const config = {
    other: 1,
    versionedDataFiles: ['datasets/view/a.csv', 'datasets/view/sub/b.csv', 'datasets/viewer/c.csv'],
    excludedFiles: ['datasets/view/notes.md', 'scripts/x.py'],
  }

  it('drops the exact key from both lists', () => {
    const res = dropMarksUnder(config, 'datasets/view/a.csv')
    expect(res?.config.versionedDataFiles).toEqual(['datasets/view/sub/b.csv', 'datasets/viewer/c.csv'])
    expect(res?.config.excludedFiles).toEqual(config.excludedFiles)
    expect(res?.removed).toEqual({ versionedDataFiles: ['datasets/view/a.csv'] })
  })

  it('drops everything below a folder, not a sibling sharing its prefix', () => {
    const res = dropMarksUnder(config, 'datasets/view')
    expect(res?.config.versionedDataFiles).toEqual(['datasets/viewer/c.csv'])
    expect(res?.config.excludedFiles).toEqual(['scripts/x.py'])
    expect(res?.config.other).toBe(1)
  })

  it('returns null when nothing was marked', () => {
    expect(dropMarksUnder(config, 'datasets/none.csv')).toBeNull()
    expect(dropMarksUnder({}, 'datasets/view')).toBeNull()
  })

  it('round-trips through restoreMarks', () => {
    const res = dropMarksUnder(config, 'datasets/view')!
    const back = restoreMarks(res.config, res.removed)
    expect([...(back.versionedDataFiles as string[])].sort()).toEqual([...config.versionedDataFiles].sort())
    expect([...(back.excludedFiles as string[])].sort()).toEqual([...config.excludedFiles].sort())
  })
})
