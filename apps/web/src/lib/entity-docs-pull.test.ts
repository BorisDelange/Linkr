import { describe, expect, it } from 'vitest'
import {
  entityDocsChanged,
  entityDocsChanges,
  presentReadme,
  readEntityDocsFrom,
  withEntityDocs,
  type DocsOwner,
} from './entity-docs-pull'

describe('presentReadme', () => {
  it('is undefined for nothing at all', () => {
    expect(presentReadme(undefined)).toBeUndefined()
    expect(presentReadme(null)).toBeUndefined()
    expect(presentReadme('')).toBeUndefined()
  })

  it('is undefined for an empty map — the {} truthiness trap', () => {
    // `{}` is truthy and toLocalized(undefined) returns exactly that, so without
    // this the docs block would report "the remote has a readme" forever.
    expect(presentReadme({})).toBeUndefined()
  })

  it('is undefined when every language is blank (a cleared readme)', () => {
    expect(presentReadme({ en: '', fr: '' })).toBeUndefined()
  })

  it('keeps a readme that has content in any language', () => {
    expect(presentReadme({ en: '', fr: 'Bonjour' })).toEqual({ en: '', fr: 'Bonjour' })
  })

  it('spreads a legacy plain string over the languages', () => {
    expect(presentReadme('legacy')).toEqual({ en: 'legacy', fr: 'legacy' })
  })
})

describe('readEntityDocsFrom', () => {
  it('splits the readme by language, primary suffix-free as the export writes it', () => {
    const docs = readEntityDocsFrom({ 'README.md': '# EN', 'README.fr.md': '# FR' }, null)
    expect(docs.readme).toEqual({ en: '# EN', fr: '# FR' })
  })

  it('recombines the licence id from the JSON with the text from the file', () => {
    // Only the text is in LICENSE.md; which licence it is stays in the entity JSON.
    const docs = readEntityDocsFrom({ 'LICENSE.md': 'MIT text' }, { license: { id: 'mit' } })
    expect(docs.license).toMatchObject({ id: 'mit', text: 'MIT text' })
  })

  it('keeps the licence identity when the repo ships no LICENSE.md', () => {
    // A licence has two halves and an entity may declare one without shipping
    // its full text. Requiring the text to keep the id dropped both, so an
    // export → import → re-export erased `license` from the manifest and the
    // next sync read that as a deletion nobody made.
    expect(readEntityDocsFrom({ 'README.md': 'x' }, { license: { id: 'mit' } }).license)
      .toEqual({ id: 'mit' })
  })

  it('has no licence when neither the file nor an id says which one', () => {
    expect(readEntityDocsFrom({ 'README.md': 'x' }, { license: {} }).license).toBeUndefined()
    expect(readEntityDocsFrom({ 'README.md': 'x' }, null).license).toBeUndefined()
  })

  it('ignores non-string entries, so a parsed JSON manifest is not mistaken for text', () => {
    const docs = readEntityDocsFrom({ '_tree.json': [{ path: 'a.sql' }], 'README.md': 'doc' }, null)
    expect(docs.readme).toEqual({ en: 'doc' })
  })

  it('returns nothing for a repo with no docs at all', () => {
    expect(readEntityDocsFrom({ '10_src.sql': 'SELECT 1' }, null)).toEqual({
      readme: undefined,
      license: undefined,
    })
  })
})

describe('entityDocsChanged', () => {
  it('is false when the remote has no docs — a pull never deletes local ones', () => {
    expect(entityDocsChanged({ readme: { en: 'mine' } }, {})).toBe(false)
  })

  it('detects a readme the local entity does not have', () => {
    expect(entityDocsChanged({}, { readme: { en: 'theirs' } })).toBe(true)
  })

  it('detects a changed readme and ignores an identical one', () => {
    expect(entityDocsChanged({ readme: { en: 'v1' } }, { readme: { en: 'v2' } })).toBe(true)
    expect(entityDocsChanged({ readme: { en: 'v2' } }, { readme: { en: 'v2' } })).toBe(false)
  })

  it('detects a change in ONE language only', () => {
    expect(entityDocsChanged(
      { readme: { en: 'same', fr: 'ancien' } },
      { readme: { en: 'same', fr: 'nouveau' } },
    )).toBe(true)
  })

  it('compares the licence too', () => {
    const remote = { license: { id: 'mit', text: 'MIT' } as never }
    expect(entityDocsChanged({}, remote)).toBe(true)
    expect(entityDocsChanged({ license: { id: 'mit', text: 'MIT' } as never }, remote)).toBe(false)
  })

  it('does not report a change when only the LOCAL side has a licence', () => {
    // The remote carries none, so there is nothing to bring in.
    expect(entityDocsChanged({ license: { id: 'mit', text: 'MIT' } as never }, {})).toBe(false)
  })
})

describe('entityDocsChanges', () => {
  it('omits what the remote does not carry, so a local licence survives', () => {
    expect(entityDocsChanges({ readme: { en: 'doc' } })).toEqual({ readme: { en: 'doc' } })
    expect(entityDocsChanges({})).toEqual({})
  })

  it('carries both when both are present', () => {
    const license = { id: 'mit', text: 'MIT' } as never
    expect(entityDocsChanges({ readme: { en: 'd' }, license })).toEqual({ readme: { en: 'd' }, license })
  })
})

describe('README language round-trip', () => {
  it('reads a French-only README.md as FRENCH, not English', () => {
    // The bug: writeReadmeFiles puts the primary language in the suffix-free
    // README.md, and the primary is the first language when there is no English.
    // The reader mapped a suffix-free name to 'en' unconditionally, so a
    // French-only readme came back as English — and a pull then overwrote the
    // real English readme with French text. `readmeLang` names the language.
    const docs = readEntityDocsFrom({ 'README.md': 'bonjour' }, { readmeLang: 'fr' })
    expect(docs.readme).toEqual({ fr: 'bonjour' })
  })

  it('still reads a suffix-free README.md as English when no marker is set', () => {
    // Repos written before the marker existed must keep reading exactly as before.
    const docs = readEntityDocsFrom({ 'README.md': 'hello' }, {})
    expect(docs.readme).toEqual({ en: 'hello' })
  })

  it('keeps explicit per-language siblings whatever the marker says', () => {
    const docs = readEntityDocsFrom(
      { 'README.md': 'bonjour', 'README.en.md': 'hello' },
      { readmeLang: 'fr' },
    )
    expect(docs.readme).toEqual({ fr: 'bonjour', en: 'hello' })
  })

  it('accepts a regional language tag', () => {
    // README.pt-BR.md used to be classified as docs but matched by no reader, so
    // its content was silently dropped on import.
    const docs = readEntityDocsFrom({ 'README.pt-BR.md': 'olá' }, {})
    expect(docs.readme).toEqual({ 'pt-BR': 'olá' })
  })
})

// Every scope's export writes README.md/LICENSE.md beside the manifest, but the
// manifest carries no readme and only the licence id. Each list page imported the
// manifest alone, so an export→import round trip silently lost both.
describe('withEntityDocs', () => {
  it('folds the README and the licence text onto the manifest', () => {
    const entity = withEntityDocs(
      { license: { id: 'Apache-2.0' } } as DocsOwner,
      { 'README.md': '# Pipeline', 'LICENSE.md': 'Apache text' },
    )
    expect(entity.readme).toEqual({ en: '# Pipeline' })
    expect(entity.license).toEqual({ id: 'Apache-2.0', text: 'Apache text' })
  })

  it('leaves a manifest that already carries a readme alone', () => {
    const entity = withEntityDocs(
      { readme: { en: 'from the manifest' } },
      { 'README.md': 'from the file' },
    )
    expect(entity.readme).toEqual({ en: 'from the manifest' })
  })

  it('adds nothing when the export carried no docs', () => {
    const entity = withEntityDocs({ license: { id: 'MIT' } } as DocsOwner, { '_tree.json': [] })
    expect(entity.readme).toBeUndefined()
    expect(entity.license).toEqual({ id: 'MIT' })
  })
})

describe('withEntityDocs honours the readme language marker', () => {
  it('folds a French-only README.md onto the FRENCH field', () => {
    // The list-page import path must not re-introduce the relabelling bug: the
    // manifest's `readmeLang` says which language the suffix-free file holds.
    const entity = withEntityDocs(
      { readmeLang: 'fr' } as DocsOwner & { readmeLang?: string },
      { 'README.md': 'bonjour' },
    )
    expect(entity.readme).toEqual({ fr: 'bonjour' })
  })
})
