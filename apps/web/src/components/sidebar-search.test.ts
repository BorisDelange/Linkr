import { describe, it, expect } from 'vitest'
import { matchesSidebarSearch, treeSearchMatches } from './SidebarSearch'

describe('matchesSidebarSearch', () => {
  it('matches case-insensitively on a substring', () => {
    expect(matchesSidebarSearch('Cohort.sql', 'COHORT')).toBe(true)
    expect(matchesSidebarSearch('Cohort.sql', 'hort.s')).toBe(true)
    expect(matchesSidebarSearch('Cohort.sql', 'zzz')).toBe(false)
  })

  it('keeps everything when the query is empty or blank', () => {
    expect(matchesSidebarSearch('anything', '')).toBe(true)
    expect(matchesSidebarSearch('anything', '   ')).toBe(true)
  })
})

describe('treeSearchMatches', () => {
  //  src/            (folder1)
  //    queries/      (folder2)
  //      cohort.sql  (file1)
  //      other.py    (file2)
  //  readme.md       (file3)
  const nodes = [
    { id: 'folder1', name: 'src', parentId: null },
    { id: 'folder2', name: 'queries', parentId: 'folder1' },
    { id: 'file1', name: 'cohort.sql', parentId: 'folder2' },
    { id: 'file2', name: 'other.py', parentId: 'folder2' },
    { id: 'file3', name: 'readme.md', parentId: null },
  ]

  it('returns null for an empty query so the tree renders untouched', () => {
    expect(treeSearchMatches(nodes, '')).toBeNull()
    expect(treeSearchMatches(nodes, '  ')).toBeNull()
  })

  it('keeps a deep match together with every folder on its path', () => {
    const keep = treeSearchMatches(nodes, 'cohort')!
    expect([...keep].sort()).toEqual(['file1', 'folder1', 'folder2'])
  })

  it('drops siblings that do not match', () => {
    const keep = treeSearchMatches(nodes, 'cohort')!
    expect(keep.has('file2')).toBe(false)
    expect(keep.has('file3')).toBe(false)
  })

  it('keeps a matching folder even when no child matches', () => {
    const keep = treeSearchMatches(nodes, 'queries')!
    expect([...keep].sort()).toEqual(['folder1', 'folder2'])
  })

  it('matches a root-level node with no ancestors to add', () => {
    expect([...treeSearchMatches(nodes, 'readme')!]).toEqual(['file3'])
  })

  it('returns an empty set when nothing matches', () => {
    expect(treeSearchMatches(nodes, 'nothing-here')!.size).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(treeSearchMatches(nodes, 'COHORT')!.has('file1')).toBe(true)
  })

  it('terminates on a parent cycle rather than looping forever', () => {
    const cyclic = [
      { id: 'a', name: 'match-me', parentId: 'b' },
      { id: 'b', name: 'b', parentId: 'a' },
    ]
    expect([...treeSearchMatches(cyclic, 'match-me')!].sort()).toEqual(['a', 'b'])
  })
})
