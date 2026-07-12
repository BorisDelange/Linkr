import { describe, it, expect } from 'vitest'
import { isLfsCandidate, buildGitAttributes, resolveLfsPaths, LFS_SIZE_THRESHOLD } from './git-lfs'

// A ~100MB parquet must never land as a normal git blob (permanent repo bloat),
// so LFS tracking triggers on data extensions OR a size threshold.
describe('isLfsCandidate', () => {
  it('tracks data extensions regardless of size', () => {
    expect(isLfsCandidate({ path: 'similarity-scores.parquet', size: 10 })).toBe(true)
    expect(isLfsCandidate({ path: 'data/x.xlsx', size: 1 })).toBe(true)
    expect(isLfsCandidate({ path: 'old.xls', size: 1 })).toBe(true)
  })

  it('tracks any file over the size threshold', () => {
    expect(isLfsCandidate({ path: 'big.csv', size: LFS_SIZE_THRESHOLD + 1 })).toBe(true)
    expect(isLfsCandidate({ path: 'notes.txt', size: LFS_SIZE_THRESHOLD + 1 })).toBe(true)
  })

  it('leaves small non-data files alone', () => {
    expect(isLfsCandidate({ path: 'project.json', size: 500 })).toBe(false)
    expect(isLfsCandidate({ path: 'small.csv', size: 1000 })).toBe(false)
    expect(isLfsCandidate({ path: 'README.md', size: LFS_SIZE_THRESHOLD })).toBe(false) // exactly at threshold, not over
  })

  it('is case-insensitive on extension', () => {
    expect(isLfsCandidate({ path: 'X.PARQUET', size: 1 })).toBe(true)
  })
})

describe('buildGitAttributes', () => {
  it('returns null when the path list is empty', () => {
    expect(buildGitAttributes([])).toBeNull()
  })

  it('emits one lfs rule per path, sorted', () => {
    expect(buildGitAttributes(['b.parquet', 'a.parquet'])).toBe(
      'a.parquet filter=lfs diff=lfs merge=lfs -text\nb.parquet filter=lfs diff=lfs merge=lfs -text\n',
    )
  })

  it('quotes paths containing spaces', () => {
    expect(buildGitAttributes(['my data.parquet'])).toBe('"my data.parquet" filter=lfs diff=lfs merge=lfs -text\n')
  })
})

describe('resolveLfsPaths', () => {
  const files = [
    { path: 'scores.parquet', size: 100 }, // candidate (extension)
    { path: 'small.csv', size: 100 }, // not a candidate
    { path: 'big.csv', size: LFS_SIZE_THRESHOLD + 1 }, // candidate (size)
  ]

  it('applies the automatic rule with no overrides', () => {
    expect(resolveLfsPaths(files, new Map())).toEqual(['big.csv', 'scores.parquet'])
  })

  it('lets an override force a small file into LFS', () => {
    expect(resolveLfsPaths(files, new Map([['small.csv', true]]))).toEqual(['big.csv', 'scores.parquet', 'small.csv'])
  })

  it('lets an override remove a candidate from LFS', () => {
    expect(resolveLfsPaths(files, new Map([['scores.parquet', false]]))).toEqual(['big.csv'])
  })
})
