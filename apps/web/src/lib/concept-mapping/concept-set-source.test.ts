import { describe, expect, it } from 'vitest'
import {
  fileTargetOf,
  naturalCompare,
  pickConceptSetEntries,
  repoLabelOf,
} from './concept-set-source'
import { cleanGitUrl } from '@/lib/git-clone'

describe('fileTargetOf', () => {
  it('extracts the path from a GitHub blob URL', () => {
    expect(fileTargetOf('https://github.com/indicate-eu/data-dictionary/blob/main/concept_sets/101.json'))
      .toBe('concept_sets/101.json')
  })

  it('extracts the path from a raw.githubusercontent URL', () => {
    expect(fileTargetOf('https://raw.githubusercontent.com/indicate-eu/data-dictionary/main/concept_sets/1.json'))
      .toBe('concept_sets/1.json')
  })

  it('handles the GitLab /-/blob/ and /raw/ forms', () => {
    expect(fileTargetOf('https://gitlab.com/g/r/-/blob/main/concept_sets/7.json'))
      .toBe('concept_sets/7.json')
    expect(fileTargetOf('https://gitlab.com/g/r/-/raw/main/concept_sets/7.json'))
      .toBe('concept_sets/7.json')
  })

  it('ignores query strings and fragments', () => {
    expect(fileTargetOf('https://github.com/o/r/blob/main/concept_sets/2.json?plain=1#L3'))
      .toBe('concept_sets/2.json')
  })

  it('returns null for a repository URL — the whole dictionary is wanted', () => {
    expect(fileTargetOf('https://github.com/indicate-eu/data-dictionary')).toBeNull()
    expect(fileTargetOf('https://github.com/indicate-eu/data-dictionary.git')).toBeNull()
    expect(fileTargetOf('https://github.com/o/r/tree/main/concept_sets')).toBeNull()
  })

  it('returns null when the target is not JSON', () => {
    expect(fileTargetOf('https://github.com/o/r/blob/main/README.md')).toBeNull()
  })
})

describe('cleanGitUrl on a single-file URL', () => {
  it('still yields a clonable repo URL, so one field serves both cases', () => {
    expect(cleanGitUrl('https://github.com/indicate-eu/data-dictionary/blob/main/concept_sets/101.json'))
      .toBe('https://github.com/indicate-eu/data-dictionary')
  })
})

describe('pickConceptSetEntries', () => {
  const ZIP = [
    'data-dictionary-main/',
    'data-dictionary-main/README.md',
    'data-dictionary-main/package.json',
    'data-dictionary-main/.github/workflows/ci.json',
    'data-dictionary-main/concept_sets/1.json',
    'data-dictionary-main/concept_sets/10.json',
    'data-dictionary-main/concept_sets/2.json',
  ]

  it('prefers the concept_sets folder over other JSON in the repo', () => {
    // package.json and the CI config must not be imported as concept sets.
    expect(pickConceptSetEntries(ZIP)).toEqual([
      'data-dictionary-main/concept_sets/1.json',
      'data-dictionary-main/concept_sets/2.json',
      'data-dictionary-main/concept_sets/10.json',
    ])
  })

  it('orders numbered files naturally', () => {
    const picked = pickConceptSetEntries(ZIP)
    expect(picked[1]).toContain('2.json')
    expect(picked[2]).toContain('10.json')
  })

  it('falls back to any JSON when there is no concept_sets folder', () => {
    expect(pickConceptSetEntries(['flat/a.json', 'flat/b.json'])).toEqual(['flat/a.json', 'flat/b.json'])
  })

  it('skips directories, dotfiles and macOS resource forks', () => {
    expect(pickConceptSetEntries([
      'r/concept_sets/', 'r/.eslintrc.json', '__MACOSX/r/._1.json', 'r/node_modules/x.json',
      'r/concept_sets/5.json',
    ])).toEqual(['r/concept_sets/5.json'])
  })

  it('narrows to a single file when the URL named one', () => {
    expect(pickConceptSetEntries(ZIP, 'concept_sets/2.json'))
      .toEqual(['data-dictionary-main/concept_sets/2.json'])
  })

  it('matches the wanted file despite the archive wrapper folder', () => {
    expect(pickConceptSetEntries(['repo-abc123/concept_sets/101.json'], 'concept_sets/101.json'))
      .toHaveLength(1)
  })

  it('returns nothing when the named file is absent, rather than importing everything', () => {
    expect(pickConceptSetEntries(ZIP, 'concept_sets/999.json')).toEqual([])
  })

  it('ignores an ATLAS-style export that is a single flat JSON', () => {
    expect(pickConceptSetEntries(['MyConceptSet.json'])).toEqual(['MyConceptSet.json'])
  })
})

describe('naturalCompare', () => {
  it('sorts numbered names in numeric order', () => {
    expect(['10.json', '2.json', '1.json'].sort(naturalCompare))
      .toEqual(['1.json', '2.json', '10.json'])
  })
})

describe('repoLabelOf', () => {
  it('names the batch after owner/repo', () => {
    expect(repoLabelOf('https://github.com/indicate-eu/data-dictionary.git'))
      .toBe('indicate-eu/data-dictionary')
    expect(repoLabelOf('https://gitlab.com/group/repo/')).toBe('group/repo')
  })
})
