import { describe, it, expect } from 'vitest'
import { isLfsCandidate, buildGitAttributes, LFS_SIZE_THRESHOLD } from './git-lfs'

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
  it('returns null when nothing qualifies', () => {
    expect(buildGitAttributes([{ path: 'project.json', size: 10 }])).toBeNull()
  })

  it('emits one lfs rule per tracked path, sorted', () => {
    const out = buildGitAttributes([
      { path: 'b.parquet', size: 1 },
      { path: 'project.json', size: 1 },
      { path: 'a.parquet', size: 1 },
    ])
    expect(out).toBe(
      'a.parquet filter=lfs diff=lfs merge=lfs -text\nb.parquet filter=lfs diff=lfs merge=lfs -text\n',
    )
  })

  it('quotes paths containing spaces', () => {
    const out = buildGitAttributes([{ path: 'my data.parquet', size: 1 }])
    expect(out).toBe('"my data.parquet" filter=lfs diff=lfs merge=lfs -text\n')
  })
})
