import { describe, expect, it } from 'vitest'
import { readWikiSnapshot } from './wiki-pull'

describe('readWikiSnapshot', () => {
  it('reads each page of the tree with its content per language, legacy verified pages as approved', () => {
    const pages = readWikiSnapshot({
      'wiki/_tree.json': JSON.stringify([
        { id: 'p1', entityId: 'setup', parentId: null, title: { en: 'Setup' }, slug: 'setup', sortOrder: 0, verified: true },
        { id: 'p2', parentId: 'p1', title: 'FAQ', slug: 'faq', sortOrder: 1 },
      ]),
      'wiki/setup.md': 'Install.\n',
      'wiki/setup.fr.md': 'Installer.\n',
      'wiki/faq--p2.md': 'Q?\n',
    })
    expect(pages.get('p1')).toMatchObject({ path: 'wiki/setup.md', content: { en: 'Install.\n', fr: 'Installer.\n' } })
    expect(pages.get('p1')?.meta.status).toBe('approved')
    expect(pages.get('p2')).toMatchObject({ path: 'wiki/faq--p2.md', content: { en: 'Q?\n' } })
    expect(pages.get('p2')?.meta.title).toMatchObject({ en: 'FAQ' })
  })
})
