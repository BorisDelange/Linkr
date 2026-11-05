import { describe, expect, it } from 'vitest'
import type { WikiPage } from '@/types'
import { resolveWikiHref, wikilinkHref } from './wiki-links'

const page = (id: string, entityId: string | undefined, slug: string) =>
  ({ id, entityId, slug }) as WikiPage

const pages = [page('p1', 'setup-guide', 'setup'), page('p2', undefined, 'faq')]

describe('resolveWikiHref', () => {
  it('follows a resolved [[wikilink]]', () => {
    expect(resolveWikiHref(wikilinkHref('p2'), pages)).toBe('p2')
    expect(resolveWikiHref(wikilinkHref('gone'), pages)).toBeNull()
  })

  it('follows a relative link to the exported file, in any language', () => {
    expect(resolveWikiHref('setup-guide.md', pages)).toBe('p1')
    expect(resolveWikiHref('./setup-guide.fr.md#install', pages)).toBe('p1')
    expect(resolveWikiHref('../wiki/faq--p2.md', pages)).toBe('p2')
  })

  it('follows a bare entity id or slug', () => {
    expect(resolveWikiHref('setup-guide', pages)).toBe('p1')
    expect(resolveWikiHref('faq', pages)).toBe('p2')
  })

  it('leaves external links, headings and app routes alone', () => {
    expect(resolveWikiHref('https://example.org/setup-guide.md', pages)).toBeNull()
    expect(resolveWikiHref('mailto:a@b.c', pages)).toBeNull()
    expect(resolveWikiHref('#setup-guide', pages)).toBeNull()
    expect(resolveWikiHref('/workspaces/x/wiki', pages)).toBeNull()
    expect(resolveWikiHref('unknown.md', pages)).toBeNull()
    expect(resolveWikiHref(undefined, pages)).toBeNull()
  })
})
