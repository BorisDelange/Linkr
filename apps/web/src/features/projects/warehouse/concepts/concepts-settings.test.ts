import { describe, it, expect } from 'vitest'
import { repoHref } from './ConceptsSettingsDialog'

describe('repoHref', () => {
  it('passes a full URL through untouched', () => {
    expect(repoHref('https://github.com/indicate-eu/data-dictionary-content')).toBe(
      'https://github.com/indicate-eu/data-dictionary-content',
    )
    expect(repoHref('http://example.org/dict')).toBe('http://example.org/dict')
  })

  it('expands an owner/repo slug to GitHub', () => {
    expect(repoHref('indicate-eu/data-dictionary-content')).toBe(
      'https://github.com/indicate-eu/data-dictionary-content',
    )
  })

  it('returns null when there is nothing to link to', () => {
    expect(repoHref(undefined)).toBeNull()
    expect(repoHref('')).toBeNull()
  })

  it('refuses anything that is not a URL or a slug, rather than linking to a 404', () => {
    expect(repoHref('INDICATE Data Dictionary')).toBeNull()
    expect(repoHref('owner/repo/extra')).toBeNull()
  })

  it('never builds a javascript: href out of untrusted metadata', () => {
    // eslint-disable-next-line no-script-url
    expect(repoHref('javascript:alert(1)')).toBeNull()
  })
})
