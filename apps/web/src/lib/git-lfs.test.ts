import { describe, it, expect } from 'vitest'
import { buildGitAttributes, resolveLfsPaths } from './git-lfs'

describe('buildGitAttributes', () => {
  it('returns null when the path list is empty', () => {
    expect(buildGitAttributes([])).toBeNull()
  })

  it('collapses data-extension paths to a single glob (matches the hand-written form)', () => {
    expect(buildGitAttributes(['b.parquet', 'a.parquet', 'x.xlsx'])).toBe(
      '*.parquet filter=lfs diff=lfs merge=lfs -text\n*.xlsx filter=lfs diff=lfs merge=lfs -text\n',
    )
  })

  it('keeps an exact rule for a non-data-extension file', () => {
    expect(buildGitAttributes(['source-concepts.csv', 'big.parquet'])).toBe(
      '*.parquet filter=lfs diff=lfs merge=lfs -text\nsource-concepts.csv filter=lfs diff=lfs merge=lfs -text\n',
    )
  })

  it('quotes an exact path containing spaces', () => {
    expect(buildGitAttributes(['my data.json'])).toBe('"my data.json" filter=lfs diff=lfs merge=lfs -text\n')
  })
})

describe('resolveLfsPaths', () => {
  const files = [
    { path: 'scores.parquet', size: 100_000_000 },
    { path: 'small.csv', size: 100 },
    { path: 'big.csv', size: 100_000_000 },
  ]

  it('tracks nothing automatically — LFS is opt-in only', () => {
    expect(resolveLfsPaths(files, new Map())).toEqual([])
  })

  it('lets an override force a file into LFS', () => {
    expect(resolveLfsPaths(files, new Map([['scores.parquet', true]]))).toEqual(['scores.parquet'])
  })

  it('treats a false override the same as no override (normal blob)', () => {
    expect(resolveLfsPaths(files, new Map([['scores.parquet', false]]))).toEqual([])
  })
})
