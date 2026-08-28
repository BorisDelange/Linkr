import { describe, expect, it } from 'vitest'

import { webRepoUrl } from '@/lib/git-web-url'

describe('webRepoUrl', () => {
  it('passes a plain https remote through — the form the app stores', () => {
    expect(webRepoUrl('https://framagit.org/interhop/linkr/linkr-public-content/databases/mimic-iv-demo'))
      .toBe('https://framagit.org/interhop/linkr/linkr-public-content/databases/mimic-iv-demo')
  })

  it('drops a .git suffix, which is a clone target and not a page', () => {
    expect(webRepoUrl('https://framagit.org/g/repo.git')).toBe('https://framagit.org/g/repo')
  })

  it('rewrites the scp-like SSH form git accepts', () => {
    expect(webRepoUrl('git@framagit.org:interhop/linkr.git'))
      .toBe('https://framagit.org/interhop/linkr')
  })

  it('rewrites ssh:// and git:// to the https page of the same host', () => {
    expect(webRepoUrl('ssh://git@framagit.org/g/repo.git')).toBe('https://framagit.org/g/repo')
    expect(webRepoUrl('git://framagit.org/g/repo.git')).toBe('https://framagit.org/g/repo')
  })

  // A remote may embed a token. Putting it in an href would leak it into browser
  // history, the referrer, and the visible status bar on hover.
  it('strips credentials, the query and the fragment', () => {
    expect(webRepoUrl('https://user:tok@framagit.org/g/repo.git?ref=x#l1'))
      .toBe('https://framagit.org/g/repo')
  })

  it('keeps a non-default port, which is part of the host', () => {
    expect(webRepoUrl('https://framagit.org:8443/g/repo.git'))
      .toBe('https://framagit.org:8443/g/repo')
  })

  it('keeps http as http rather than promoting a local remote to https', () => {
    expect(webRepoUrl('http://localhost:3000/g/repo')).toBe('http://localhost:3000/g/repo')
  })

  it('trims a trailing slash', () => {
    expect(webRepoUrl('https://framagit.org/g/repo/')).toBe('https://framagit.org/g/repo')
  })

  // Anything that is not a browsable page yields null, and the badge stays plain
  // text rather than becoming a link to nowhere.
  it('refuses what a browser cannot open', () => {
    expect(webRepoUrl('file:///srv/repos/local.git')).toBeNull()
    expect(webRepoUrl('/srv/repos/local.git')).toBeNull()
    expect(webRepoUrl('https://framagit.org')).toBeNull()
    expect(webRepoUrl('not a url')).toBeNull()
    expect(webRepoUrl('')).toBeNull()
    expect(webRepoUrl(undefined)).toBeNull()
    expect(webRepoUrl(null)).toBeNull()
  })
})
