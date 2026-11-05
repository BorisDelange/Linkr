import { describe, expect, it } from 'vitest'
import { readWikiSnapshot } from './wiki-pull'

describe('readWikiSnapshot', () => {
  it('reads each page of the tree by entityId with its content per language', () => {
    const pages = readWikiSnapshot({
      'wiki/_tree.json': JSON.stringify([
        { entityId: 'setup', parentEntityId: null, title: { en: 'Setup' }, slug: 'setup', sortOrder: 0 },
        { entityId: 'faq', parentEntityId: 'setup', title: { en: 'FAQ' }, slug: 'faq', sortOrder: 1 },
      ]),
      'wiki/setup.md': 'Install.\n',
      'wiki/setup.fr.md': 'Installer.\n',
      'wiki/faq.md': 'Q?\n',
    })
    expect(pages.get('setup')).toMatchObject({ path: 'wiki/setup.md', content: { en: 'Install.\n', fr: 'Installer.\n' } })
    expect(pages.get('faq')?.meta.parentId).toBe('setup')
  })

  it('reads a tree of the older format: ids, legacy names, verified pages as approved', () => {
    const pages = readWikiSnapshot({
      'wiki/_tree.json': JSON.stringify([
        { id: 'p1', entityId: 'setup', parentId: null, title: { en: 'Setup' }, slug: 'setup', sortOrder: 0, verified: true },
        { id: 'p2', parentId: 'p1', title: 'FAQ', slug: 'faq', sortOrder: 1 },
      ]),
      'wiki/setup.md': 'Install.\n',
      'wiki/faq--p2.md': 'Q?\n',
    })
    expect(pages.get('setup')?.meta.status).toBe('approved')
    expect(pages.get('faq--p2')).toMatchObject({ path: 'wiki/faq--p2.md', content: { en: 'Q?\n' } })
    expect(pages.get('faq--p2')?.meta.parentId).toBe('setup')
    expect(pages.get('faq--p2')?.meta.title).toMatchObject({ en: 'FAQ' })
  })
})
