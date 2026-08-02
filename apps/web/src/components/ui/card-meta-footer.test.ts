import { describe, it, expect } from 'vitest'
import { websiteHref, orcidHref } from './card-meta-footer'

describe('websiteHref', () => {
  it('keeps a full http(s) URL as-is', () => {
    expect(websiteHref('https://www.chu-hugo.fr/')).toBe('https://www.chu-hugo.fr/')
    expect(websiteHref('http://example.org')).toBe('http://example.org')
  })

  it('prefixes a bare domain with https://', () => {
    expect(websiteHref('chu-hugo.fr')).toBe('https://chu-hugo.fr')
    expect(websiteHref('www.example.org/path')).toBe('https://www.example.org/path')
  })

  it('trims surrounding whitespace', () => {
    expect(websiteHref('  chu-hugo.fr  ')).toBe('https://chu-hugo.fr')
  })

  it('returns null for empty or non-domain text', () => {
    expect(websiteHref('')).toBeNull()
    expect(websiteHref('   ')).toBeNull()
    expect(websiteHref('not a url')).toBeNull()
  })
})

describe('orcidHref', () => {
  it('builds the orcid.org URL from a bare id', () => {
    expect(orcidHref('0009-0002-6055-6935')).toBe('https://orcid.org/0009-0002-6055-6935')
  })

  it('accepts the X check digit', () => {
    expect(orcidHref('0000-0002-1825-009X')).toBe('https://orcid.org/0000-0002-1825-009X')
  })

  it('keeps a full URL as-is', () => {
    expect(orcidHref('https://orcid.org/0009-0002-6055-6935')).toBe('https://orcid.org/0009-0002-6055-6935')
  })

  it('returns null for empty or malformed ids', () => {
    expect(orcidHref('')).toBeNull()
    expect(orcidHref('1234')).toBeNull()
  })
})
