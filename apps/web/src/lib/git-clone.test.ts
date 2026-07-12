import { describe, it, expect } from 'vitest'
import { cleanGitUrl, normalizeGitUrl } from './git-clone'

// Users paste repo web-page URLs; if we don't clean them, the clone/verify fails.
describe('cleanGitUrl', () => {
  it('strips GitLab /-/tree navigation + query', () => {
    expect(cleanGitUrl('https://framagit.org/interhop/linkr/test-project/-/tree/main?ref_type=heads')).toBe(
      'https://framagit.org/interhop/linkr/test-project',
    )
  })

  it('strips GitLab /-/blob and merge_requests', () => {
    expect(cleanGitUrl('https://gitlab.com/g/s/repo/-/blob/main/README.md')).toBe('https://gitlab.com/g/s/repo')
    expect(cleanGitUrl('https://gitlab.com/g/repo/-/merge_requests/3')).toBe('https://gitlab.com/g/repo')
  })

  it('keeps GitLab subgroups intact (cut only at /-/)', () => {
    expect(cleanGitUrl('https://framagit.org/a/b/c/repo/-/tree/dev')).toBe('https://framagit.org/a/b/c/repo')
  })

  it('strips GitHub tree/blob/commit/pull segments', () => {
    expect(cleanGitUrl('https://github.com/owner/repo/tree/main')).toBe('https://github.com/owner/repo')
    expect(cleanGitUrl('https://github.com/owner/repo/blob/main/x.py')).toBe('https://github.com/owner/repo')
    expect(cleanGitUrl('https://github.com/owner/repo/pull/42')).toBe('https://github.com/owner/repo')
  })

  it('drops query and fragment on a plain repo URL', () => {
    expect(cleanGitUrl('https://github.com/owner/repo?tab=readme#top')).toBe('https://github.com/owner/repo')
  })

  it('leaves a clean URL untouched (aside from trailing slash)', () => {
    expect(cleanGitUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo')
    expect(cleanGitUrl('https://github.com/owner/repo/')).toBe('https://github.com/owner/repo')
  })

  it('does not touch a repo literally named like a nav segment', () => {
    // "tree" as a repo name (no following segment) must survive.
    expect(cleanGitUrl('https://github.com/owner/tree')).toBe('https://github.com/owner/tree')
  })

  it('leaves SSH-style URLs alone', () => {
    expect(cleanGitUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git')
  })
})

describe('normalizeGitUrl', () => {
  it('cleans then appends .git', () => {
    expect(normalizeGitUrl('https://framagit.org/interhop/linkr/test-project/-/tree/main?ref_type=heads')).toBe(
      'https://framagit.org/interhop/linkr/test-project.git',
    )
  })

  it('keeps an existing .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git')
  })
})
