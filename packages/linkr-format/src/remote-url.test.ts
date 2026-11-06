import { describe, expect, it } from 'vitest'
import { isCloneableRemoteUrl, isSafeGitRef, lfsEndpoint } from './remote-url.js'

describe('isCloneableRemoteUrl', () => {
  it('accepts https, ssh and scp-style remotes', () => {
    for (const url of ['https://framagit.org/g/repo', 'ssh://git@framagit.org/g/r.git', 'git@framagit.org:g/r.git']) {
      expect(isCloneableRemoteUrl(url)).toBe(true)
    }
  })

  it('refuses every other transport and anything git would read as an option', () => {
    for (const url of ['file:///srv/repo', '/srv/repo', '../repo', 'http://host/r', 'ext::sh -c x', '-oProxyCommand=x', 'git://host/r', '', 42, undefined]) {
      expect(isCloneableRemoteUrl(url)).toBe(false)
    }
  })
})

describe('isSafeGitRef', () => {
  it('accepts branch and tag names', () => {
    for (const ref of ['main', 'release/2.4', 'v2.4.5', 'feature_x-1']) expect(isSafeGitRef(ref)).toBe(true)
  })

  it('refuses options, refspecs and whatever git itself refuses', () => {
    for (const ref of ['--upload-pack=x', '-x', 'a:b', '+main', 'a..b', 'a b', '', 42]) expect(isSafeGitRef(ref)).toBe(false)
  })
})

describe('lfsEndpoint', () => {
  it('derives the endpoint from the remote, as git-lfs does', () => {
    expect(lfsEndpoint('https://framagit.org/g/repo')).toBe('https://framagit.org/g/repo.git/info/lfs')
    expect(lfsEndpoint('https://framagit.org/g/repo.git/')).toBe('https://framagit.org/g/repo.git/info/lfs')
  })

  it('keeps a non-http remote as written', () => {
    expect(lfsEndpoint('git@framagit.org:g/r.git')).toBe('git@framagit.org:g/r.git')
    expect(lfsEndpoint('ssh://git@framagit.org/g/r.git')).toBe('ssh://git@framagit.org/g/r.git')
  })
})
