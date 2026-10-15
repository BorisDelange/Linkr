import { describe, expect, it } from 'vitest'
import { gitUrlHost, privateTokenMissing } from './git-host'

// The host keys the account's stored token: a wrong parse asks about the wrong one.
describe('gitUrlHost', () => {
  it('reads an https URL, keeping a non-default port', () => {
    expect(gitUrlHost(' https://gitlab.com/g/repo.git ')).toBe('gitlab.com')
    expect(gitUrlHost('https://gitlab.chu.fr:8443/g/repo')).toBe('gitlab.chu.fr:8443')
    expect(gitUrlHost('https://gitlab.com:443/g/repo')).toBe('gitlab.com')
  })

  it('reads an scp-style remote, with or without a user', () => {
    expect(gitUrlHost('git@gitlab.com:g/repo.git')).toBe('gitlab.com')
    expect(gitUrlHost('gitlab.com:g/repo')).toBe('gitlab.com')
  })

  it('returns null for what names no host', () => {
    expect(gitUrlHost('')).toBeNull()
    expect(gitUrlHost('not a url')).toBeNull()
  })
})

describe('privateTokenMissing', () => {
  it('needs a typed or stored token only for a private repo', () => {
    expect(privateTokenMissing(false, '', null)).toBe(false)
    expect(privateTokenMissing(true, '  ', null)).toBe(true)
    expect(privateTokenMissing(true, '', false)).toBe(true)
    expect(privateTokenMissing(true, '', true)).toBe(false)
    expect(privateTokenMissing(true, 'glpat-x', false)).toBe(false)
  })
})
